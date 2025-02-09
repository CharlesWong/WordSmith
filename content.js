// Add at the top of content.js
const DEFAULT_SETTINGS = {
  style: 'formal',
  tone: 'neutral',
  simpleMode: true,  // Default to simple mode
  enabled: true  // Default to enabled
};

// Debug logging controlled by environment
class GrammarChecker {
  constructor(config = {}) {
    // Add settings property
    this.settings = DEFAULT_SETTINGS;
    this.loadSettings();
    
    // Initialize debug mode
    this.DEBUG_MODE = localStorage.getItem('DEBUG_GRAMMAR_CHECK') === 'true';
    console.log('Initializing GrammarChecker...', config);
    this.provider = config.provider || 'OLLAMA';
    this.endpoint = config.endpoint || 'http://localhost:11434/api/generate';
    this.suggestionBox = this.createSuggestionBox();
    this.loadingCircle = this.createLoadingCircle();  
    this.setupProviders();
    
    this._textInputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
    
    // Always initialize monitoring
    this.init();
    this.debounceTimeout = null;
    this.lastAnalyzedText = '';
    this.maxRetries = 3;
    this.retryDelay = 1000;

    // Bind methods to maintain 'this' context
    this.handleInput = this.handleInput.bind(this);
    this.handleFocus = this.handleFocus.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.hideSuggestionBox = this.hideSuggestionBox.bind(this);
    this.handleDocumentClick = this.handleDocumentClick.bind(this);

    // Add document click handler
    document.addEventListener('click', this.handleDocumentClick);

    // Add settings update listener
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'settingsUpdated') {
        console.log('Settings updated:', message.settings);
        this.settings = message.settings;
        
        // Just hide/show UI based on enabled state
        if (!this.settings.enabled) {
          this.hideUI();
        }
        
        // Always update the suggestion box header
        if (this.suggestionBox) {
          const suggestions = this.lastSuggestions || { grammar: [], style: [], tone: [] };
          this.prepareSuggestionBox(suggestions);
        }
      } else if (message.type === 'initializeExtension') {
        // Re-initialize the extension
        this.init();
        // Start checking the current active element if any
        const activeElement = document.activeElement;
        if (message.forceCheck || (activeElement && activeElement.matches(this.textInputSelector))) {
          // Force a check on the current text
          const text = activeElement?.value || activeElement?.innerText || '';
          if (text.length > 0) {
            this.lastTarget = activeElement;
            this.checkGrammar(text).then(suggestions => {
              if (suggestions) {
                this.lastSuggestions = suggestions;
                this.updateSuggestions(activeElement, suggestions);
              }
            });
          }
        }
      }
    });
  }

  // Change the getter to use the private property
  get textInputSelector() {
    return this._textInputSelector;
  }

  // Debug logging method
  debugLog(...args) {
    if (this.DEBUG_MODE) {
        console.log('[GrammarCheck]', ...args);
    }
  }

  // UI Components
  createSuggestionBox() {
    const box = document.createElement("div");
    box.id = "suggestion-box";
    box.style.display = "none";
    document.body.appendChild(box);

    return box;
  }

  // Create loading circle
  createLoadingCircle() {
    console.log('Creating loading circle');
    const circle = document.createElement('div');
    circle.id = 'suggestion-circle';
    circle.className = 'suggestion-circle';
    // Set initial styles directly
    const styles = {
      display: 'flex',
      position: 'fixed',
      width: '32px',
      height: '32px',
      borderRadius: '50%',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#9F7AEA',  // Default color
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
      zIndex: '2147483647'
    };
    Object.assign(circle.style, styles);
    
    const content = document.createElement('div');
    content.className = 'circle-content';
    content.style.display = 'flex';
    content.style.alignItems = 'center';
    content.style.justifyContent = 'center';
    content.style.width = '100%';
    content.style.height = '100%';
    content.style.color = 'white';
    content.setAttribute('aria-label', 'Writing suggestions');
    circle.appendChild(content);
    
    document.body.appendChild(circle);
    return circle;
  }

  // Add method to observe target visibility
  setupVisibilityObserver() {
    this.visibilityObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const circle = document.getElementById('suggestion-circle');
        if (!circle) return;

        // Only hide if the target is completely out of view
        if (entry.intersectionRatio === 0) {
          // Target is completely invisible
          circle.style.opacity = '0';
          setTimeout(() => {
            if (entry.intersectionRatio === 0) { // Double check before hiding
              circle.style.display = 'none';
            }
          }, 300);
        } else {
          // Target is at least partially visible
          if (this.lastAnalyzedText) { // Only show if we have analyzed text
            circle.style.display = 'flex';
            setTimeout(() => {
              if (entry.intersectionRatio > 0) { // Double check before showing
                circle.style.opacity = '1';
              }
            }, 10);
          }
        }
      });
    }, {
      threshold: [0, 0.1], // Track both completely hidden and slightly visible states
      rootMargin: '0px' // Be exact about visibility
    });
  }

  // LLM Provider Setup
  setupProviders() {
    this.providers = {
      OLLAMA: {
        endpoint: this.endpoint,
        formatRequest: (text) => ({
          model: "llama2",
          prompt: `Analyze the following text and provide clear, specific suggestions for improvement. For each error, include the start and end position in the text.

Input text: "${text}"

Please provide suggestions in the following JSON format:
{
  "errors": [
    {
      "type": "grammar|spelling|style",
      "text": "error text",
      "suggestion": "corrected text",
      "position": {
        "start": number,
        "end": number
      }
    }
  ]
}`,
          stream: false
        }),
        formatResponse: (data, inputText) => {
          const response = data.response.trim();
          console.log('=== START PARSING RESPONSE ===');
          console.log('Raw response:', response);
          
          const categories = {
            grammar: [],
            style: [],
            tone: []
          };
          
          let currentCategory = null;
          let currentIssue = {};
          
          // Track seen issues to avoid duplicates
          const seenIssues = new Set();
          
          // Helper function to create unique key for an issue
          const getIssueKey = (issue) => {
            return `${issue.text}|${issue.suggestion}`;
          };
          
          // Helper function to add issue if not duplicate and has valid suggestion
          const addIssueIfValid = (category, issue) => {
            // Skip if suggestion is empty or indicates no change needed
            if (!issue.suggestion || 
                issue.suggestion.toLowerCase().includes('none') ||
                issue.suggestion.toLowerCase().includes('no correction') ||
                issue.suggestion === issue.text ||
                issue.suggestion.includes(' or ') || // Skip multiple suggestions
                !inputText.includes(issue.text)) { // Use inputText here
              console.log('Skipping invalid suggestion:', issue);
              return;
            }

            const key = getIssueKey(issue);
            if (!seenIssues.has(key)) {
              seenIssues.add(key);
              // Add position information for exact replacement
              issue.position = {
                start: inputText.indexOf(issue.text),
                end: inputText.indexOf(issue.text) + issue.text.length
              };
              categories[category].push({...issue});
              console.log(`Added valid issue to ${category}:`, issue);
            } else {
              console.log(`Skipped duplicate issue:`, issue);
            }
          };
          
          // Split by lines and process each line
          const lines = response.split('\n');
          console.log(`Total lines to process: ${lines.length}`);
          
          for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            // Skip empty lines
            if (!line) {
              console.log(`Line ${i}: Empty line, skipping`);
              continue;
            }
            
            // Remove markdown formatting
            line = line.replace(/\*\*/g, '').trim();
            console.log(`Line ${i}: Processing "${line}"`);
            
            // Detect category headers
            if (line.includes('Grammar Issues')) {
              currentCategory = 'grammar';
              console.log(`Line ${i}: Found Grammar category`);
              continue;
            } else if (line.includes('Style Issues')) {
              currentCategory = 'style';
              console.log(`Line ${i}: Found Style category`);
              continue;
            } else if (line.includes('Tone Issues')) {
              currentCategory = 'tone';
              console.log(`Line ${i}: Found Tone category`);
              continue;
            }
            
            // Check for numbered items (new issue)
            const numberMatch = line.match(/^\d+\./);
            if (numberMatch) {
              if (currentIssue.text && currentIssue.suggestion) {
                addIssueIfValid(currentCategory, currentIssue);
              }
              currentIssue = { type: currentCategory };
              console.log(`Line ${i}: Started new issue #${numberMatch[0]} in ${currentCategory} category`);
            }
            
            // Parse issue components
            if (line.includes('Problematic Text:')) {
              const text = line.split('Problematic Text:')[1].trim().replace(/^"(.*)"$/, '$1');
              console.log(`Line ${i}: Found problematic text: "${text}"`);
              if (text && text.toLowerCase() !== 'none') {
                currentIssue.text = text;
              }
            } else if (line.includes('Suggested Correction:')) {
              const suggestion = line.split('Suggested Correction:')[1].trim().replace(/^"(.*)"$/, '$1');
              console.log(`Line ${i}: Found suggestion: "${suggestion}"`);
              if (suggestion && suggestion.toLowerCase() !== 'none') {
                currentIssue.suggestion = suggestion;
              }
            } else if (line.includes('Explanation:')) {
              const explanation = line.split('Explanation:')[1].trim();
              currentIssue.explanation = explanation;
              
              // Save completed issue if unique
              if (currentIssue.text && currentIssue.suggestion) {
                addIssueIfValid(currentCategory, currentIssue);
              }
              currentIssue = { type: currentCategory };
            }
          }
          
          // Add the last issue if complete and unique
          if (currentIssue.text && currentIssue.suggestion) {
            addIssueIfValid(currentCategory, currentIssue);
          }
          
          console.log('=== FINAL PARSED CATEGORIES ===');
          console.log(JSON.stringify(categories, null, 2));
          console.log('=== END PARSING RESPONSE ===');
          
          return categories;
        },
        headers: {
          "Content-Type": "application/json"
        }
      }
    };
  }

  createPrompt(text) {
    return `As a grammar and style assistant, analyze the following text and provide clear, specific suggestions for improvement. For each error, include the start and end position in the text.

Input text: "${text}"

Please provide suggestions in the following JSON format:
{
  "errors": [
    {
      "type": "grammar|spelling|style",
      "text": "error text",
      "suggestion": "corrected text",
      "position": {
        "start": number,
        "end": number
      }
    }
  ]
}`;
  }

  // Core functionality
  async checkGrammar(text) {
    if (!text.trim()) return [];

    try {
      await this.loadSettings();
      this.clearSuggestions();
      
      // Position and show loading circle near the current input
      if (this.lastTarget) {
        const rect = this.lastTarget.getBoundingClientRect();
        const circle = document.getElementById('suggestion-circle');
        if (circle) {
          circle.style.position = 'fixed';
          circle.style.top = `${rect.top + window.scrollY + 5}px`;
          circle.style.left = `${rect.right + window.scrollX + 5}px`;
          circle.style.removeProperty("right");  // Remove any previously set right value
          circle.style.display = 'flex';
          circle.style.visibility = 'visible';
          circle.style.opacity = '1';
        }
      }
      
      // Show loading circle
      this.updateCircleState('loading');
      
      // Get suggestions
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'analyze',
          text: text,
          preferences: this.settings
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
            return;
          }
          resolve(response);
        });
      });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Analysis failed');
      }

      // Update circle with suggestions count
      const suggestions = response.suggestions;
      const totalSuggestions = Object.values(suggestions)
        .reduce((sum, arr) => sum + arr.length, 0);
      
      if (totalSuggestions > 0) {
        this.updateCircleState('has-suggestions', totalSuggestions);
      } else {
        this.updateCircleState('no-suggestions');
      }

      return response.suggestions || [];
    } catch (error) {
      console.error('Grammar check failed:', error);
      this.updateCircleState('no-suggestions');
      return [];
    }
  }

  // UI Updates
  updateSuggestionBoxPosition(element, cursorPos) {
    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Get box dimensions (or use approximate if not rendered yet)
    const box = this.suggestionBox;
    const boxWidth = box.offsetWidth || 300;  // Default width if not rendered
    const boxHeight = box.offsetHeight || 200; // Default height if not rendered

    // Calculate available space in different directions
    const spaceBelow = viewportHeight - cursorPos.bottom;
    const spaceAbove = cursorPos.top;
    const spaceRight = viewportWidth - cursorPos.left;
    const spaceLeft = cursorPos.left;

    // Determine vertical position
    let top;
    if (spaceBelow >= boxHeight || spaceBelow > spaceAbove) {
        // Position below if enough space or more space than above
        top = Math.min(cursorPos.bottom + window.scrollY + 5, 
                    viewportHeight + window.scrollY - boxHeight - 5);
    } else {
        // Position above
        top = Math.max(cursorPos.top + window.scrollY - boxHeight - 5, 
                    window.scrollY + 5);
    }

    // Determine horizontal position
    let left;
    if (spaceRight >= boxWidth || spaceRight > spaceLeft) {
        // Position to the right if enough space or more space than left
        left = Math.min(cursorPos.left + window.scrollX, 
                     viewportWidth + window.scrollX - boxWidth - 5);
    } else {
        // Position to the left
        left = Math.max(cursorPos.left + window.scrollX - boxWidth, 
                     window.scrollX + 5);
    }

    // Apply positions
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;

    // Add debug logging
    this.debugLog('Positioning suggestion box:', {
        viewport: { width: viewportWidth, height: viewportHeight },
        box: { width: boxWidth, height: boxHeight },
        space: { below: spaceBelow, above: spaceAbove, right: spaceRight, left: spaceLeft },
        position: { top, left },
        scroll: { x: window.scrollX, y: window.scrollY }
    });
  }

  async updateSuggestions(target, suggestions) {
    this.lastTarget = target;
    console.log('updateSuggestions received:', suggestions);
    
    if (!suggestions || Object.values(suggestions).every(arr => arr.length === 0)) {
      this.updateCircleState('no-suggestions');
      return;
    }

    // Store suggestions for later use
    this.lastSuggestions = suggestions;
    
    // Count total suggestions
    const totalSuggestions = Object.values(suggestions).reduce((sum, arr) => sum + arr.length, 0);
    
    // Update circle with count but don't show box yet
    this.updateCircleState('has-suggestions', totalSuggestions);
    const circle = document.getElementById('suggestion-circle');
    if (circle) {
      circle.style.display = 'flex';
      circle.style.opacity = '1';
      
      // Add hover handler to show suggestion box
      circle.onmouseenter = () => {
        this.showSuggestionBox();  // No need to pass suggestions, we have this.lastSuggestions
      };
      
      // Add click handler to toggle suggestion box
      circle.onclick = () => {
        if (this.suggestionBox.style.display === 'none') {
          this.showSuggestionBox();
        } else {
          this.hideSuggestionBox();
        }
      };

      const cursorPos = this.getCursorPosition(target);
      this.updateSuggestionBoxPosition(target, cursorPos);
    }

    // Prepare suggestion box content but don't show it yet
    this.prepareSuggestionBox(suggestions);
  }

  // Update the prepareSuggestionBox method
  async prepareSuggestionBox(suggestions) {
    const settings = await this.getSettings();
    const box = this.suggestionBox;
    box.innerHTML = '';
    
    if (settings.simpleMode) {
      this.prepareSimpleModeBox(suggestions);
    } else {
      this.prepareAdvancedModeBox(suggestions);
    }
  }

  prepareSimpleModeBox(suggestions) {
    console.log('Preparing simple mode box with suggestions:', suggestions);
    if (!suggestions?.simple?.[0]?.suggestion) {
      console.log('No simple suggestions available');
      return;
    }
    
    const box = this.suggestionBox;
    const suggestion = suggestions.simple[0];
    console.log('Using suggestion:', suggestion);
    
    // Clear existing content
    box.innerHTML = '';
    
    // Add preferences header like in advanced mode
    const prefsHeader = document.createElement('div');
    prefsHeader.className = 'preferences-header';
    prefsHeader.innerHTML = `
      <div class="current-preferences">
        <span class="pref-label">Style: <span class="pref-value">${this.settings.style}</span></span>
        <span class="pref-label">Tone: <span class="pref-value">${this.settings.tone}</span></span>
      </div>
    `;
    box.appendChild(prefsHeader);
    
    // Create suggestion item
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    // Ensure changes array exists
    const changes = suggestion.changes || [];
    item.innerHTML = `
      <div class="suggestion-content">
        <div class="original">${suggestion.text || 'Full text'}</div>
        <div class="arrow">→</div>
        <div class="correction">${suggestion.suggestion}</div>
        <div class="explanation-text">${suggestion.explanation || ''}</div>
        <div class="changes-list">
          ${changes.map(change => `<div class="change-item">• ${change}</div>`).join('')}
        </div>
      </div>
      <button class="apply-suggestion">Apply</button>
    `;
    
    item.querySelector('.apply-suggestion').addEventListener('click', () => {
      this.applySuggestion(this.lastTarget, suggestion);
    });
    
    box.appendChild(item);
    console.log('Box content after preparation:', box.innerHTML);
  }

  prepareAdvancedModeBox(suggestions) {
    // Always add the header with current style and tone settings
    const prefsHeader = document.createElement('div');
    prefsHeader.className = 'preferences-header';
    prefsHeader.innerHTML = `
      <div class="current-preferences">
        <span class="pref-label">Style: <span class="pref-value">${this.settings.style}</span></span>
        <span class="pref-label">Tone: <span class="pref-value">${this.settings.tone}</span></span>
      </div>
    `;
    this.suggestionBox.appendChild(prefsHeader);

    // Flag to check if we have any suggestion
    let hasSuggestions = false;

    // Append suggestions for each category
    Object.keys(suggestions).forEach(category => {
      if (suggestions[category].length > 0) {
        hasSuggestions = true;

        // Create and append category header
        const header = document.createElement('div');
        header.className = 'suggestion-category';
        header.textContent = category.charAt(0).toUpperCase() + category.slice(1) + ' Suggestions';
        this.suggestionBox.appendChild(header);

        // Append each suggestion item
        suggestions[category].forEach(sugg => {
          const item = document.createElement('div');
          item.className = `suggestion-item ${category}-error`;
          item.innerHTML = `
            <div class="suggestion-content">
              <div class="original">${sugg.text}</div>
              <div class="arrow">→</div>
              <div class="correction">${sugg.suggestion}</div>
              <div class="explanation-text">${sugg.explanation || ''}</div>
            </div>
            <button class="apply-suggestion">Apply</button>
          `;
          
          // Attach apply event
          item.querySelector('.apply-suggestion').addEventListener('click', () => {
            this.applySuggestion(this.lastTarget, sugg);
          });
          
          this.suggestionBox.appendChild(item);
        });
      }
    });

    // If no suggestions exist, optionally add a placeholder message
    if (!hasSuggestions) {
      const noContent = document.createElement('div');
      noContent.className = 'no-suggestions';
      noContent.textContent = 'No suggestions found.';
      this.suggestionBox.appendChild(noContent);
    }
  }

  // Update the showSuggestionBox method
  showSuggestionBox() {
    console.log('Showing suggestion box with suggestions:', this.lastSuggestions);
    if (this.lastSuggestions) {
      const cursorPos = this.getCursorPosition(this.lastTarget);
      this.updateSuggestionBoxPosition(this.lastTarget, cursorPos);
      
      // First prepare content, then show box
      this.prepareSuggestionBox(this.lastSuggestions);
      
      this.suggestionBox.style.display = 'block';
      this.suggestionBox.setAttribute('role', 'dialog');
      this.suggestionBox.setAttribute('aria-label', 'Writing Suggestions');
      
      // Add visible class after a short delay to ensure content is rendered
      setTimeout(() => {
        this.suggestionBox.classList.add('visible');
      }, 50);
    }
  }

  // Add method to hide suggestion box
  hideSuggestionBox() {
    this.suggestionBox.classList.remove('visible');
    this.suggestionBox.removeAttribute('aria-hidden');
    setTimeout(() => {
        this.suggestionBox.style.display = "none";
    }, 300);
  }

  // Initialize event listeners
  init() {
    // Add listeners to all matching elements
    document.querySelectorAll(this.textInputSelector).forEach(element => {
      element.addEventListener('input', this.handleInput);
      element.addEventListener('focus', this.handleFocus);
    });
    
    // Add listener for dynamically added elements
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.matches(this.textInputSelector)) {
            node.addEventListener('input', this.handleInput);
            node.addEventListener('focus', this.handleFocus);
          }
        });
      });
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Event Handlers
  async handleInput(event) {
    console.log('Input event triggered');
    const target = event.target;
    this.lastTarget = target;
    
    // Hide suggestion box when user starts typing
    this.hideSuggestionBox();
    
    const text = target.value || target.innerText;
    
    // Skip processing for delete/backspace to allow normal text deletion
    if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
      this.clearSuggestions();
      return;
    }

    // Skip if text is too short
    if (!text || text.length < 3) {
      this.clearSuggestions();
      return;
    }

    // Get latest settings before checking
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error getting settings:', chrome.runtime.lastError);
            resolve({ success: false });
            return;
          }
          resolve(response);
        });
      });
      
      if (response?.success) {
        this.settings = response.settings;
        console.log('Updated settings before check:', this.settings);
      }
    } catch (error) {
      console.error('Failed to get latest settings:', error);
    }

    // Only check grammar if extension is enabled
    if (!this.settings?.enabled) {
      console.log('Grammar checker is disabled, skipping check');
      return;
    }

    // Debounce the grammar check
    this.debounce(async () => {
      // Skip if text hasn't changed
      if (text === this.lastAnalyzedText) return;
      
      console.log('Checking grammar for:', text);
      const suggestions = await this.checkGrammar(text);
      if (suggestions) {
        this.lastAnalyzedText = text;
        this.lastSuggestions = suggestions;
        this.updateSuggestions(target, suggestions);
      }
    }, 500);
  }

  handleFocus = async (event) => {
    console.log('Focus event triggered on:', event.target);
    const text = event.target.value || event.target.innerText;
    
    // Only update if text has changed since last analysis
    if (text !== this.lastAnalyzedText) {
        try {
            this.lastAnalyzedText = text;
            await this.updateSuggestions(event.target);
        } catch (error) {
            console.error('Error in handleFocus:', error);
        }
    }
  }

  handleBlur = (event) => {
    console.log('Blur event triggered');
    setTimeout(() => {
        // Check if focus is still within the target or suggestion box
        const activeElement = document.activeElement;
        const isRelated = event.target.contains(activeElement) || 
                        this.suggestionBox.contains(activeElement);
        
        if (!isRelated) {
            this.suggestionBox.classList.remove('visible');
            setTimeout(() => {
                this.suggestionBox.style.display = "none";
            }, 300);
        }
    }, 200);
  }

  // DOM Management
  attachListeners(element) {
    console.log('Attaching listeners to:', element);
    
    // Remove existing listeners first to prevent duplicates
    element.removeEventListener("input", this.handleInput);
    element.removeEventListener("focus", this.handleFocus);
    element.removeEventListener("blur", this.handleBlur);
    
    // Add listeners
    element.addEventListener("input", this.handleInput);
    element.addEventListener("focus", this.handleFocus);
    element.addEventListener("blur", this.handleBlur);

    // Initial check if element has content
    const text = element.value || element.innerText;
    if (text && text.trim()) {
        this.lastAnalyzedText = text;
        this.checkGrammar(text).then(suggestions => {
            if (suggestions) {
                this.updateSuggestions(element, suggestions);
            }
        });
    }
  }

  observeDOM() {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (this.isTextInput(node)) {
                        this.attachListeners(node);
                    }
                    const children = node.querySelectorAll?.(this.textInputSelector);
                    if (children?.length) {
                        children.forEach(child => this.attachListeners(child));
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Utilities
  isTextInput(element) {
    return element.matches?.(this.textInputSelector);
  }

  // Initialization
  init() {
    console.log('Initializing grammar checker...');
    try {
      // Load settings first
      this.loadSettings().then(() => {
        // Find all text input elements
        const textElements = document.querySelectorAll(this.textInputSelector);
        console.log('Found text elements:', textElements.length);
        
        // Attach listeners to each element
        textElements.forEach(el => {
          console.log('Attaching listeners to:', el);
          // Remove existing listeners first
          el.removeEventListener('input', this.handleInput);
          
          // Add input listener
          el.addEventListener('input', this.handleInput);
        });

        // Start observing DOM changes
        this.observeDOM();

        console.log('Initialization complete');
      });
    } catch (error) {
      console.error('Initialization failed:', error);
      setTimeout(() => this.init(), 2000);
    }
  }

  // Update the highlightErrors method
  highlightErrors(target, text, errors) {
    // Remove any existing error overlays
    const existingOverlay = document.getElementById('error-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }

    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'error-overlay';
    
    // Position overlay exactly over the target element
    const rect = target.getBoundingClientRect();
    overlay.style.position = 'absolute';
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.pointerEvents = 'none'; // Allow clicking through to the input
    
    // Add error markers
    errors.forEach(error => {
        if (error.position) {
            const marker = document.createElement('div');
            marker.className = `error-marker ${error.type || 'style'}-error`;
            
            // Calculate marker position
            const range = document.createRange();
            const tempSpan = document.createElement('span');
            tempSpan.textContent = text.substring(0, error.position.start);
            const startOffset = tempSpan.getBoundingClientRect().width;
            
            tempSpan.textContent = text.substring(error.position.start, error.position.end);
            const width = tempSpan.getBoundingClientRect().width;
            
            marker.style.left = `${startOffset}px`;
            marker.style.width = `${width}px`;
            marker.title = error.suggestion || error.text;
            
            overlay.appendChild(marker);
        }
    });

    document.body.appendChild(overlay);
  }

  // Update applySuggestion method
  applySuggestion(target, suggestion) {
    if (!target) {
      console.error("No target element available for applying suggestion.");
      return;
    }
    
    let originalContent = "";
    
    if (target.value !== undefined) {
      originalContent = target.value;
    } else if (target.isContentEditable) {
      originalContent = target.innerText;
    } else {
      originalContent = target.innerText;
    }

    // Strip quotes from both the text to find and the replacement
    const textToFind = suggestion.text.replace(/^["']|["']$/g, '');
    const replacement = suggestion.suggestion.replace(/^["']|["']$/g, '');

    console.log('Applying suggestion:', {
      originalContent,
      textToFind,
      replacement
    });

    if (originalContent.indexOf(textToFind) === -1) {
      console.error("Suggestion text not found in target content.", {
        suggestionText: textToFind,
        originalContent
      });
      return;
    }

    const newContent = originalContent.replace(textToFind, replacement);
    
    if (target.value !== undefined) {
      target.value = newContent;
    } else if (target.isContentEditable) {
      target.innerText = newContent;
    } else {
      target.innerText = newContent;
    }

    target.dispatchEvent(new Event('input', { bubbles: true }));
    this.hideSuggestionBox();
  }

  // Add debounce method
  debounce(func, wait) {
    clearTimeout(this.debounceTimeout);
    this.debounceTimeout = setTimeout(func, wait);
  }

  // Add method to update circle state
  updateCircleState(state, count = 0) {
    const circle = document.getElementById('suggestion-circle');
    if (!circle) return;

    // Reset classes and then force inline styles with !important
    circle.className = 'suggestion-circle';
    circle.classList.add(state);

    const content = circle.querySelector('.circle-content');
    if (!content) return;
    
    switch (state) {
      case 'loading':
        content.innerHTML = `
          <div class="spinner" style="
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255,255,255,0.9);
            border-top: 2px solid transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          "></div>`;
        circle.style.backgroundColor = '#9F7AEA';  // Purple for loading
        content.setAttribute('aria-label', 'Checking writing...');
        break;
      case 'has-suggestions':
        content.textContent = count;
        circle.style.backgroundColor = '#F56565';  // Red for suggestions
        content.setAttribute('aria-label', `${count} writing suggestions available`);
        break;
      case 'no-suggestions':
        content.textContent = '0';
        circle.style.backgroundColor = '#38B2AC';  // Teal for no suggestions
        content.setAttribute('aria-label', 'No writing suggestions');
        break;
    }
  }

  // Add method to handle extension reloading
  async reloadExtension() {
    return new Promise((resolve) => {
        // Remove existing listeners
        const elements = document.querySelectorAll(this.textInputSelector);
        elements.forEach(el => {
            el.removeEventListener("input", this.handleInput);
            el.removeEventListener("focus", this.handleFocus);
            el.removeEventListener("blur", this.handleBlur);
        });

        // Remove document click handler
        document.removeEventListener('click', this.handleDocumentClick);

        // Clean up UI elements
        this.hideUI();

        // Reinitialize after a short delay
        setTimeout(() => {
            this.suggestionBox = this.createSuggestionBox();
            this.setupProviders();
            this.init();
            // Re-add document click handler
            document.addEventListener('click', this.handleDocumentClick);
            resolve();
        }, 1000);
    });
  }

  // Add helper method to extract examples
  extractExamples(text) {
    const examples = [];
    
    // Look for examples between quotes
    const quoteMatches = text.match(/"([^"]+)"/g);
    if (quoteMatches) {
        examples.push(...quoteMatches.map(m => m.replace(/"/g, '')));
    }
    
    // Look for examples after "such as" or similar phrases
    const phrases = ['such as', 'like', 'for example'];
    phrases.forEach(phrase => {
        if (text.includes(phrase)) {
            const afterPhrase = text.split(phrase)[1];
            if (afterPhrase) {
                const options = afterPhrase.split(/,|\bor\b/).map(opt => 
                    opt.trim().replace(/^["']|["']$/g, '') // Remove quotes
                    .replace(/\.$/, '') // Remove trailing period
                ).filter(opt => opt); // Remove empty strings
                examples.push(...options);
            }
        }
    });
    
    return [...new Set(examples)]; // Remove duplicates
  }

  // Add method to get cursor position
  getCursorPosition(element) {
    let position = { left: 0, top: 0, height: 0 };
    
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        // For input/textarea elements
        if (typeof element.selectionStart === 'number') {
            // Create a temporary span to measure text
            const div = document.createElement('div');
            const text = element.value.substring(0, element.selectionStart);
            div.textContent = text;
            div.style.font = window.getComputedStyle(element).font;
            div.style.position = 'absolute';
            div.style.visibility = 'hidden';
            div.style.whiteSpace = 'pre-wrap';
            div.style.width = window.getComputedStyle(element).width;
            document.body.appendChild(div);
            
            const rect = element.getBoundingClientRect();
            position = {
                left: rect.left + div.offsetWidth,
                top: rect.top + (div.offsetHeight % parseInt(window.getComputedStyle(element).lineHeight)),
                height: parseInt(window.getComputedStyle(element).lineHeight)
            };
            
            document.body.removeChild(div);
        }
    } else {
        // For contenteditable elements
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            position = {
                left: rect.right,
                top: rect.top,
                height: rect.height
            };
        }
    }
    
    return position;
  }

  // Update document click handler
  handleDocumentClick = (event) => {
    const circle = this.loadingCircle;
    const box = this.suggestionBox;
    
    // Hide if click is outside both circle and box, and not on the input
    if (!circle?.contains(event.target) && 
        !box?.contains(event.target) && 
        event.target !== this.lastTarget) {
      this.hideSuggestionBox();
    }
  }

  // Add method to hide UI elements
  hideUI() {
    // Hide suggestion box with animation
    this.suggestionBox.classList.remove('visible');
    setTimeout(() => {
        this.suggestionBox.style.display = "none";
    }, 300);

    // Hide circle with animation
    const circle = document.getElementById('suggestion-circle');
    if (circle) {
        circle.style.opacity = '0';
        setTimeout(() => {
            circle.style.display = 'none';
        }, 300);
    }
  }

  // Add new helper method to clear suggestions
  clearSuggestions() {
    this.lastSuggestions = null;
    this.updateCircleState('no-suggestions');
    this.hideSuggestionBox();
  }

  // Update loadSettings method
  async loadSettings() {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("Runtime error in loadSettings:", chrome.runtime.lastError.message);
            // Fallback to default settings if there's an error (e.g. extension context invalidated)
            return resolve({ success: false });
          }
          resolve(response);
        });
      });
      if (response?.success) {
        this.settings = response.settings;
        console.log('Loaded settings:', this.settings);
      } else {
        console.warn('Using default settings');
        this.settings = DEFAULT_SETTINGS;
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      this.settings = DEFAULT_SETTINGS;
    }
  }

  // Update updateUI method
  updateUI() {
    // Implementation of updateUI method
  }

  // Add getSettings method
  async getSettings() {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("Runtime error in getSettings:", chrome.runtime.lastError.message);
            resolve({ success: false });
            return;
          }
          resolve(response);
        });
      });
      
      return response?.success ? response.settings : DEFAULT_SETTINGS;
    } catch (error) {
      console.error('Error getting settings:', error);
      return DEFAULT_SETTINGS;
    }
  }
}

// Update the test connection function
async function testOllamaConnection() {
    try {
        console.log('Testing Ollama connection...');
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ 
                action: 'checkConnection' 
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Runtime error:', chrome.runtime.lastError);
                    resolve(false);
                    return;
                }

                if (!response) {
                    console.error('No response from background script');
                    resolve(false);
                    return;
                }

                console.log('Connection test response:', response);
                resolve(response.success);
            });
        });
    } catch (error) {
        console.error('Ollama connection test failed:', {
            message: error.message,
            name: error.name,
            stack: error.stack
        });
        return false;
    }
}

// Initialize the grammar checker
console.log('Starting extension...');
testOllamaConnection().then(isConnected => {
    if (isConnected) {
        console.log('Successfully connected to Ollama');
        const checker = new GrammarChecker({
            provider: 'OLLAMA',
            endpoint: 'http://localhost:11434/api/generate'
        });
    } else {
        console.error('Failed to connect to Ollama. Please make sure it is running.');
    }
});

// Add this near the top of content.js
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'debug') {
        console.log('[Background Debug]:', message.message);
    }
});

// Save preferences and notify content script to update settings
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', () => {
    const newSettings = {
      style: document.getElementById('style').value,
      tone: document.getElementById('tone').value
    };
    // Save to local storage (grammarSettings)
    chrome.storage.local.set({ grammarSettings: newSettings }, () => {
      // Also update chrome.storage.sync if needed
      chrome.storage.sync.set(newSettings);
 
      // Notify content script of settings change
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'settingsUpdated',
            settings: newSettings
          });
        }
      });
    });
  });
});