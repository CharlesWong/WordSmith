// Debug logging controlled by environment
class GrammarChecker {
  constructor(config = {}) {
    // Initialize debug mode
    this.DEBUG_MODE = localStorage.getItem('DEBUG_GRAMMAR_CHECK') === 'true';
    console.log('Initializing GrammarChecker...', config);
    this.provider = config.provider || 'OLLAMA';
    this.endpoint = config.endpoint || 'http://localhost:11434/api/generate';
    this.suggestionBox = this.createSuggestionBox();
    this.loadingCircle = this.createLoadingCircle();  
    this.setupProviders();
    
    // Change this line - store as private property instead of trying to set the getter
    this._textInputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
    
    this.init();
    this.debounceTimeout = null;
    this.lastAnalyzedText = '';  // Track last analyzed text
    this.maxRetries = 3;  // Maximum number of retry attempts
    this.retryDelay = 1000;  // Delay between retries in ms

    // Add document click handler
    document.addEventListener('click', this.handleDocumentClick);
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

    // Create indicator circle
    const circle = document.createElement("div");
    circle.id = "suggestion-circle";
    circle.className = "suggestion-circle";
    circle.innerHTML = '<div class="circle-content">0</div>';
    document.body.appendChild(circle);

    // Add hover handler to circle
    circle.addEventListener('mouseenter', () => {
      if (box.style.display === "none" && this.lastTarget) {
        box.style.display = "block";
        box.classList.add('visible');
        this.updateSuggestionBoxPosition(this.lastTarget);
      }
    });

    // Add click handler to circle (keep this for mobile devices)
    circle.addEventListener('click', () => {
      if (box.style.display === "none") {
        box.style.display = "block";
        box.classList.add('visible');
        this.updateSuggestionBoxPosition(this.lastTarget);
      } else {
        box.classList.remove('visible');
        setTimeout(() => {
          box.style.display = "none";
        }, 300);
      }
    });

    // Add intersection observer to hide circle when target is not visible
    this.setupVisibilityObserver();

    return box;
  }

  // Replace createSuggestionCircle with createLoadingCircle
  createLoadingCircle() {
    const circle = document.createElement("div");
    circle.id = "loading-circle";
    circle.className = "loading-circle";
    
    // Add styles for the circle and its contents
    const style = document.createElement('style');
    style.textContent = `
        .loading-circle {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .loading-circle:hover {
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            transform: translateY(-1px);
        }
        .loading-circle .circle-content {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .loading-circle .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid #f3f3f3;
            border-top: 2px solid #3498db;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        .loading-circle .count {
            font-size: 12px;
            font-weight: bold;
            color: #3498db;
            text-align: center;
            line-height: 24px;
            width: 100%;
            height: 100%;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
    
    circle.innerHTML = `
        <div class="circle-content">
            <div class="spinner"></div>
            <div class="count" style="display: none;"></div>
        </div>
    `;
    
    circle.style.position = 'fixed';
    circle.style.zIndex = '10000';
    circle.style.display = 'none';
    
    // Add hover behavior
    circle.addEventListener('mouseenter', () => {
        if (this.lastSuggestions) {
            this.showSuggestionBox(this.lastSuggestions);
        }
    });
    
    circle.addEventListener('mouseleave', (e) => {
        const box = this.suggestionBox;
        const boxRect = box.getBoundingClientRect();
        if (!(e.clientX >= boxRect.left && e.clientX <= boxRect.right && 
              e.clientY >= boxRect.top && e.clientY <= boxRect.bottom)) {
            this.hideSuggestionBox();
        }
    });
    
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

    let attempts = 0;
    while (attempts < this.maxRetries) {
      try {
        // Show loading circle
        if (this.loadingCircle) {
          const selection = window.getSelection();
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          
          this.loadingCircle.querySelector('.spinner').style.display = 'block';
          this.loadingCircle.querySelector('.count').style.display = 'none';
          this.loadingCircle.style.top = `${rect.top + window.scrollY - 30}px`;
          this.loadingCircle.style.left = `${rect.right + window.scrollX + 10}px`;
          this.loadingCircle.style.display = 'flex';
          this.loadingCircle.style.opacity = '1';
        }

        // Get suggestions (now includes deduplication in background)
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyze',
            text: text,
            preferences: {
              style: 'formal',
              tone: 'neutral'
            }
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

        if (!response.suggestions) {
          return [];
        }

        // Update circle to show suggestion count
        if (this.loadingCircle) {
          const totalSuggestions = Object.values(response.suggestions)
            .reduce((sum, arr) => sum + arr.length, 0);
          
          if (totalSuggestions > 0) {
            const spinner = this.loadingCircle.querySelector('.spinner');
            const count = this.loadingCircle.querySelector('.count');
            
            spinner.style.display = 'none';
            count.textContent = totalSuggestions;
            count.style.display = 'block';
            
            this.lastSuggestions = response.suggestions;
          } else {
            this.loadingCircle.style.opacity = '0';
            setTimeout(() => {
              this.loadingCircle.style.display = 'none';
            }, 300);
          }
        }

        return response.suggestions;
      } catch (error) {
        console.error(`Attempt ${attempts + 1} failed:`, error);
        attempts++;
        
        if (attempts < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }

    return [];
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
    
    if (!suggestions || Object.values(suggestions).every(arr => arr.length === 0)) {
      this.updateCircleState('no-suggestions');
      return;
    }

    // Count total suggestions
    const totalSuggestions = Object.values(suggestions).reduce((sum, arr) => sum + arr.length, 0);
    
    // Update circle with count but don't show box yet
    this.updateCircleState('has-suggestions', totalSuggestions);
    const circle = document.getElementById('suggestion-circle');
    if (circle) {
      circle.style.display = 'flex';
      circle.style.opacity = '1';
      
      // Add hover handler to show/hide suggestion box
      circle.onmouseenter = () => {
        this.showSuggestionBox(suggestions);
      };
      
      circle.onmouseleave = (e) => {
        // Check if mouse is moving to suggestion box
        const box = this.suggestionBox;
        const boxRect = box.getBoundingClientRect();
        if (!(e.clientX >= boxRect.left && e.clientX <= boxRect.right && 
              e.clientY >= boxRect.top && e.clientY <= boxRect.bottom)) {
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
  prepareSuggestionBox(suggestions) {
    // Clear previous suggestions
    this.suggestionBox.innerHTML = '';

    // Add styles for the suggestion box content
    const style = document.createElement('style');
    style.textContent = `
      .suggestion-category {
        font-weight: bold;
        padding: 8px;
        margin-top: 8px;
        color: #2d3748;
        border-bottom: 1px solid #e2e8f0;
      }
      .suggestion {
        padding: 12px;
        border-bottom: 1px solid #e2e8f0;
      }
      .suggestion:last-child {
        border-bottom: none;
      }
      .suggestion-content {
        margin-bottom: 8px;
      }
      .suggestion-main {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      .original {
        color: #e53e3e;
        text-decoration: line-through;
      }
      .arrow {
        color: #718096;
      }
      .correction {
        color: #38a169;
        font-weight: 500;
      }
      .explanation {
        font-size: 0.9em;
        color: #718096;
        font-style: italic;
        margin-top: 4px;
      }
      .apply-btn {
        padding: 4px 12px;
        background: #3182ce;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      .apply-btn:hover {
        background: #2c5282;
      }
    `;
    document.head.appendChild(style);

    // Add suggestions by category
    Object.entries(suggestions).forEach(([category, categorySuggestions]) => {
      if (categorySuggestions.length === 0) return;

      // Add category header
      const header = document.createElement('div');
      header.className = 'suggestion-category';
      header.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      this.suggestionBox.appendChild(header);

      // Add suggestions
      categorySuggestions.forEach(suggestion => {
        const suggestionDiv = document.createElement('div');
        suggestionDiv.className = 'suggestion';
        
        // Create suggestion content with original text, arrow, and correction
        const content = document.createElement('div');
        content.className = 'suggestion-content';
        
        const mainContent = document.createElement('div');
        mainContent.className = 'suggestion-main';
        mainContent.innerHTML = `
          <span class="original">${suggestion.text}</span>
          <span class="arrow">→</span>
          <span class="correction">${suggestion.suggestion}</span>
        `;
        content.appendChild(mainContent);

        // Add explanation if present
        if (suggestion.explanation) {
          const explanation = document.createElement('div');
          explanation.className = 'explanation';
          explanation.textContent = suggestion.explanation;
          content.appendChild(explanation);
        }

        suggestionDiv.appendChild(content);

        // Add apply button
        const applyBtn = document.createElement('button');
        applyBtn.className = 'apply-btn';
        applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', () => {
          this.applySuggestion(this.lastTarget, suggestion);
          this.hideSuggestionBox();
        });
        suggestionDiv.appendChild(applyBtn);

        this.suggestionBox.appendChild(suggestionDiv);
      });
    });

    // Add hover behavior
    this.suggestionBox.onmouseenter = () => {
      this.suggestionBox.style.display = 'block';
      this.suggestionBox.classList.add('visible');
    };

    this.suggestionBox.onmouseleave = () => {
      this.hideSuggestionBox();
    };
  }

  // Add method to show suggestion box
  showSuggestionBox(suggestions) {
    this.suggestionBox.style.display = 'block';
    setTimeout(() => {
        this.suggestionBox.classList.add('visible');
    }, 10);
  }

  // Add method to hide suggestion box
  hideSuggestionBox() {
    this.suggestionBox.classList.remove('visible');
    setTimeout(() => {
        this.suggestionBox.style.display = "none";
    }, 300);
  }

  // Event Handlers
  handleInput = async (event) => {
    console.log('Input event triggered on:', event.target);
    const text = event.target.value || event.target.innerText;
    
    // If text hasn't changed, don't make a new request
    if (text === this.lastAnalyzedText) {
        return;
    }

    // Clear previous timeout
    if (this.debounceTimeout) {
        clearTimeout(this.debounceTimeout);
    }

    // Set new timeout for grammar check
    this.debounceTimeout = setTimeout(async () => {
        try {
            // Show loading state
            this.updateCircleState('loading');
            const circle = document.getElementById('suggestion-circle');
            if (circle) {
                circle.style.display = 'flex';
                circle.style.opacity = '1';
                const cursorPos = this.getCursorPosition(event.target);
                this.updateSuggestionBoxPosition(event.target, cursorPos);
            }

            // Get suggestions
            const suggestions = await this.checkGrammar(text);
            if (suggestions) {
                this.lastAnalyzedText = text;
                await this.updateSuggestions(event.target, suggestions);
            }
        } catch (error) {
            console.error('Error in handleInput:', error);
            this.updateCircleState('no-suggestions');
        }
    }, 1000);
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
    console.log('Initializing...');
    try {
        // Find all text input elements
        const textElements = document.querySelectorAll(this.textInputSelector);
        console.log('Found text elements:', textElements.length);
        
        // Attach listeners to each element
        textElements.forEach(el => {
            this.attachListeners(el);
            
            // Initial check if element has content
            const text = el.value || el.innerText;
            if (text && text.trim()) {
                // Trigger input event to start analysis
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        // Start observing DOM changes
        this.observeDOM();

        console.log('Initialization complete');
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
    const text = target.value || target.innerText;
    if (suggestion.position) {
        // If we have position information, replace just that part
        const newText = text.substring(0, suggestion.position.start) +
                        suggestion.suggestion +
                        text.substring(suggestion.position.end);
        if (target.value !== undefined) {
            target.value = newText;
        } else {
            target.innerText = newText;
        }
    } else {
        // If no position, try to find and replace the text
        const regex = new RegExp(suggestion.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const newText = text.replace(regex, suggestion.suggestion || '');
        if (target.value !== undefined) {
            target.value = newText;
        } else {
            target.innerText = newText;
        }
    }

    // Hide suggestion box
    this.suggestionBox.classList.remove('visible');
    setTimeout(() => {
        this.suggestionBox.style.display = "none";
    }, 300);

    // Show loading state in circle
    this.updateCircleState('loading');

    // Rerun the check after a short delay to let the text update
    setTimeout(async () => {
        try {
            await this.updateSuggestions(target);
        } catch (error) {
            console.error('Error rechecking after applying suggestion:', error);
            this.updateCircleState('no-suggestions');
        }
    }, 500);
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

    // Reset classes and add new state
    circle.className = 'suggestion-circle';
    circle.classList.add(state);

    const content = circle.querySelector('.circle-content');
    if (!content) return;
    
    switch (state) {
        case 'loading':
            content.innerHTML = '<div class="spinner"></div>';
            circle.style.display = 'flex';
            circle.style.opacity = '1';
            break;
        case 'has-suggestions':
            content.textContent = count;
            circle.style.display = 'flex';
            circle.style.opacity = '1';
            break;
        case 'no-suggestions':
            content.textContent = '0';
            circle.style.opacity = '0';
            setTimeout(() => {
                circle.style.display = 'none';
            }, 300);
            break;
        default:
            circle.style.opacity = '0';
            setTimeout(() => {
                circle.style.display = 'none';
            }, 300);
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

  // Add document click handler
  handleDocumentClick = (event) => {
    const circle = document.getElementById('suggestion-circle');
    const box = this.suggestionBox;
    
    // Check if click is outside both circle and box
    if (!circle?.contains(event.target) && !box?.contains(event.target)) {
        // Hide both circle and box
        this.hideUI();
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