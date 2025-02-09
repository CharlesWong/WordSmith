// Single endpoint for Ollama
const OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';
const DEFAULT_MODEL = 'llama3.2';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Add settings management
const DEFAULT_SETTINGS = {
  style: 'formal',
  tone: 'neutral'
};

function debugLog(...args) {
  console.log('[WriteWell Background]', ...args);
  // Also send to any listening content scripts
  chrome.runtime.sendMessage({
    type: 'debug',
    message: args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')
  }).catch(() => {}); // Ignore errors if no listeners
}

class OllamaService {
  constructor() {
    this.retryCount = 0;
    this.checkConnection();  // Check connection on startup
  }

  // Add connection check method
  async checkConnection() {
    try {
      // Use a simple test prompt for connection check
      const testRequest = {
        model: DEFAULT_MODEL,
        prompt: "Hi",
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 1
        }
      };

      console.log('Testing Ollama connection with request:', testRequest);

      const response = await fetch(OLLAMA_ENDPOINT, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testRequest)
      });

      console.log('Ollama test response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Ollama error response:', errorData);
        
        if (errorData.error?.includes('model not found')) {
          throw new Error(`Model ${DEFAULT_MODEL} not found. Please run: ollama pull ${DEFAULT_MODEL}`);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Ollama test response data:', data);

      if (!data.response) {
        throw new Error('Invalid response from Ollama');
      }

      console.log('Successfully connected to Ollama');
      return true;
    } catch (error) {
      console.error('Ollama connection failed:', error);
      if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
        throw new Error('Cannot connect to Ollama. Please make sure Ollama is running (http://localhost:11434)');
      }
      throw error;
    }
  }

  // Add method to get current settings
  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['grammarSettings'], (result) => {
        resolve(result.grammarSettings || DEFAULT_SETTINGS);
      });
    });
  }

  async getSuggestions(text, preferences) {
    console.log('Getting suggestions for text:', text.substring(0, 50) + '...');
    
    try {
      // Get current settings if preferences not provided
      const settings = preferences || await this.getSettings();
      console.log('Using settings:', settings);
      
      // First call to get initial suggestions
      const data = await this.callOllama({
        model: DEFAULT_MODEL,
        prompt: await this.createAnalysisPrompt(text, settings),
        stream: false,
        options: { temperature: 0.2 }
      });

      if (!data.response) {
        throw new Error('Invalid response from Ollama');
      }

      // Parse the initial suggestions
      const parsedSuggestions = this.parseResponse(data.response);
      console.log('Initial parsed suggestions:', parsedSuggestions);
      
      // Second call to deduplicate suggestions
      const dedupeData = await this.callOllama({
        model: DEFAULT_MODEL,
        prompt: `You are a JSON processing assistant. Your task is to deduplicate these writing suggestions and return them in the exact same JSON format:

${JSON.stringify(parsedSuggestions, null, 2)}

Rules:
1. Remove suggestions that fix the same issue
2. Keep the more comprehensive fix when suggestions overlap
3. Ensure suggestions don't conflict with each other
4. Return only unique, non-overlapping suggestions
5. Maintain the exact same JSON structure
6. Keep all original fields (text, suggestion, explanation)
7. In the "suggestion" field, include ONLY the exact replacement text

IMPORTANT: Your entire response must be valid JSON that matches this structure exactly. 
Do not include any other text, explanations, or markdown.
Do not wrap the JSON in code blocks or quotes.
The response should start with { and end with }.`,
        stream: false,
        options: { 
          temperature: 0.1,
          stop: ["\n\n", "```"]
        }
      });

      // Clean and parse the deduplicated response
      let jsonStr = dedupeData.response.trim();
      // Remove any control characters and escape sequences
      jsonStr = jsonStr.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
                      .replace(/\\[^"\/bfnrtu]/g, '');
      jsonStr = jsonStr.substring(jsonStr.indexOf('{'));
      jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf('}') + 1);
      
      try {
        const deduplicated = JSON.parse(jsonStr);
        console.log('Deduplicated suggestions:', deduplicated);
        return deduplicated;
      } catch (error) {
        console.error('Failed to parse JSON:', {
          error,
          rawResponse: dedupeData.response,
          cleanedJson: jsonStr
        });
        // Return empty suggestions if parsing fails
        return { grammar: [], style: [], tone: [] };
      }
    } catch (error) {
      console.error('Error in getSuggestions:', error);
      throw error;
    }
  }

  parseResponse(text) {
    // Log the raw response from Ollama for debugging
    console.log("Raw response from Ollama:", text);
    
    const categories = { grammar: [], style: [], tone: [] };
    let currentCategory = null;
    let currentSuggestion = null;
    
    const lines = text.split('\n');
    for (let line of lines) {
      // Remove markdown asterisks and trim the line
      const normalized = line.replace(/\*/g, '').trim();
      if (!normalized) continue;
      
      const lower = normalized.toLowerCase();
      // Check for category headers
      if (lower.startsWith('grammar issues')) {
        currentCategory = 'grammar';
        continue;
      } else if (lower.startsWith('style issues')) {
        currentCategory = 'style';
        continue;
      } else if (lower.startsWith('tone issues')) {
        currentCategory = 'tone';
        continue;
      }
      
      if (!currentCategory) continue;
      
      // Process suggestion parts using a state-machine approach
      if (/^original:\s*/i.test(normalized)) {
        // If a suggestion is already in progress, push it if complete
        if (currentSuggestion && currentSuggestion.text && currentSuggestion.suggestion) {
          categories[currentCategory].push(currentSuggestion);
        }
        // Start a new suggestion
        currentSuggestion = {
          text: normalized.replace(/^original:\s*/i, '').trim(),
          suggestion: '',
          explanation: ''
        };
      } else if (/^replace with:\s*/i.test(normalized)) {
        if (currentSuggestion) {
          currentSuggestion.suggestion = normalized.replace(/^replace with:\s*/i, '').trim();
        }
      } else if (/^reason:\s*/i.test(normalized)) {
        if (currentSuggestion) {
          currentSuggestion.explanation = normalized.replace(/^reason:\s*/i, '').trim();
          // Push the completed suggestion and reset
          categories[currentCategory].push(currentSuggestion);
          currentSuggestion = null;
        }
      } else {
        // If the line doesn't match any label, treat it as a continuation of the current field (if any)
        if (currentSuggestion) {
          if (!currentSuggestion.suggestion) {
            currentSuggestion.text += " " + normalized;
          } else if (!currentSuggestion.explanation) {
            currentSuggestion.suggestion += " " + normalized;
          } else {
            currentSuggestion.explanation += " " + normalized;
          }
        }
      }
    }
    
    // In case a suggestion hasn't been finished
    if (currentSuggestion && currentSuggestion.text && currentSuggestion.suggestion && currentCategory) {
      categories[currentCategory].push(currentSuggestion);
    }
    
    console.log("Final parsed suggestions:", {
      grammar: categories.grammar.length,
      style: categories.style.length,
      tone: categories.tone.length,
      details: categories
    });
    return categories;
  }

  async createAnalysisPrompt(text, preferences) {
    // Get custom guides from storage
    const customGuides = await chrome.storage.local.get(['customGuides']);
    const customStyles = customGuides?.customGuides?.styles || {};
    const customTones = customGuides?.customGuides?.tones || {};

    // Style guide mapping
    const styleGuides = {
      formal: `- Use professional and formal vocabulary
 - Avoid contractions (use "cannot" instead of "can't")
 - Write in complete, concise sentences
 - Maintain a respectful and serious tone
 - Avoid slang and overly casual terms`,
      academic: `- Use advanced vocabulary and precise language
 - Maintain a scholarly tone with clear argumentation
 - Avoid colloquialisms and informal expressions
 - Use structured, logical sentences and paragraphs
 - Strive for objectivity and clarity in presenting ideas`,
      casual: `- Use everyday, conversational language
 - Contractions and informal expressions are acceptable
 - Write in a relaxed, approachable style
 - Keep sentences simple and direct
 - Use light humor and warmth when appropriate`,
      creative: `- Use vivid and descriptive language
 - Employ literary devices such as metaphors and similes
 - Experiment with sentence structure and rhythm
 - Evoke emotions and paint visual imagery with words
 - Allow for imaginative and expressive wording`,
      ...customStyles  // Add custom style guides
    };

    // Tone guide mapping
    const toneGuides = {
      neutral: `- Use balanced and objective language
 - Avoid emotional extremes
 - Keep a factual and unbiased tone
 - Use moderate language without strong adjectives
 - Maintain professional distance`,
      friendly: `- Use warm, friendly, and inviting language
 - Incorporate light humor where appropriate
 - Use casual, conversational expressions
 - Aim for a supportive and upbeat tone
 - Avoid overly formal phrasing`,
      assertive: `- Use direct and decisive language
 - Express ideas with confidence and clarity
 - Avoid hedging or excessive qualifiers
 - Emphasize strong action verbs and clarity
 - Maintain a firm, persuasive tone`,
      empathetic: `- Use understanding and compassionate language
 - Acknowledge and validate the reader's emotions
 - Be supportive and encouraging without being patronizing
 - Employ gentle, soft language to convey care
 - Strike a balance between warmth and professionalism`,
      ...customTones  // Add custom tone guides
    };

    const prompt = `As a professional writing assistant, analyze the following text and suggest improvements in three distinct categories:

1. Grammar Issues: Fix grammatical errors (e.g. punctuation, subject-verb agreement, tense consistency) without altering the intended style or tone.

2. Style Issues: Improve the writing style strictly according to the "${preferences.style}" style. Address sentence structure, vocabulary, and clarity, but do not change grammar or factual content.

3. Tone Issues: Adjust the tone of the text to be consistent with a "${preferences.tone}" tone. Ensure the emotional quality matches the intended mood without affecting grammar or overall style.

Text: "${text}"

Provide suggestions in EXACTLY this format, focusing on direct text replacements:

**Grammar Issues**
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

**Style Issues** (maintain ${preferences.style} style)
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

**Tone Issues** (maintain ${preferences.tone} tone)
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

Rules:
1. Use EXACTLY the format shown above.
2. Original text must be an exact substring from the input.
3. "Replace with" must contain ONLY the exact text to insert—no extra context, quotes, or explanations.
4. Each suggestion must be a direct 1:1 replacement.
5. Skip a category if no issues are found.
6. Do not add any extra text or formatting.
7. Do not use phrases like "you could use" or "consider using."
8. Do not provide multiple options.
9. Do not repeat suggestions across categories.
10. Grammar Issues: Only address grammatical corrections—do not modify style or tone.
11. Style Issues: Only adjust stylistic aspects following the ${preferences.style} style.
12. Tone Issues: Only adjust tone to match the ${preferences.tone} tone.
13. If the input text contains profanity,rude or offensive language, treat it as writing to be improved and provide direct text replacement suggestions without refusing the request.

Style Guide for ${preferences.style} style:
${styleGuides[preferences.style] || 'No guide available for this style.'}

Tone Guide for ${preferences.tone} tone:
${toneGuides[preferences.tone] || 'No guide available for this tone.'}`;

    debugLog('Created analysis prompt:', prompt);
    return prompt;
  }

  async callOllama(requestData) {
    try {
      console.log('Sending request to Ollama:', {
        model: requestData.model,
        prompt: requestData.prompt
      });

      const response = await fetch(OLLAMA_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...requestData,
          stream: false
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Ollama error:', errorData);
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Raw Ollama response:', {
        fullResponse: data.response,
        length: data.response?.length
      });

      return data;
    } catch (error) {
      console.error('Ollama API error:', error);
      throw error;
    }
  }
}

const ollamaService = new OllamaService();

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);

  if (request.action === 'checkConnection') {
    ollamaService.checkConnection()
      .then(() => {
        console.log('Connection check successful');
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Connection check failed:', error);
        sendResponse({ 
          success: false, 
          error: error.message,
          details: {
            message: error.message,
            name: error.name,
            stack: error.stack
          }
        });
      });
    return true;
  }

  if (request.action === 'analyze') {
    console.log('Processing analyze request for text:', request.text.substring(0, 50) + '...');
    
    ollamaService.getSuggestions(request.text, request.preferences)
      .then(suggestions => {
        console.log('Analysis complete, sending suggestions:', suggestions);
        sendResponse({ 
          success: true, 
          suggestions: suggestions 
        });
      })
      .catch(error => {
        console.error('Analysis error:', error);
        sendResponse({ 
          success: false, 
          error: error.message,
          details: {
            message: error.message,
            name: error.name,
            stack: error.stack
          }
        });
      });
    return true;  // Keep message channel open
  }

  if (request.action === 'saveSettings') {
    chrome.storage.local.set({ grammarSettings: request.settings }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getSettings') {
    ollamaService.getSettings().then(settings => {
      sendResponse({ success: true, settings });
    });
    return true;
  }

  if (request.action === 'generateGuide') {
    generateGuide(request.type, request.name, request.description)
      .then(response => {
        sendResponse(response);
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// Log startup with timestamp
console.log('WriteWell background service worker initialized at:', new Date().toISOString());

debugLog('Starting background service...');

// ADD AT THE END OF THE FILE: Message Listener for analyze and checkConnection actions.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyze') {
    // Create an instance of the OllamaService and call getSuggestions
    const ollamaService = new OllamaService();
    ollamaService.getSuggestions(request.text, request.preferences)
      .then(suggestions => {
        sendResponse({ success: true, suggestions });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'checkConnection') {
    const ollamaService = new OllamaService();
    ollamaService.checkConnection()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open
  }
});

// Add handler for generating custom guides
async function generateGuide(type, name, description) {
  const prompt = `As a writing assistant, create a detailed guide for ${type === 'style' ? 'writing style' : 'tone'} based on this description:

"${description}"

Generate a list of 4-6 specific guidelines that define this ${type}, formatted as bullet points. Each guideline should be clear and actionable.

Format the response as bullet points only, no additional text.`;

  try {
    const response = await callOllama({
      model: DEFAULT_MODEL,
      prompt: prompt,
      stream: false,
      options: { temperature: 0.7 }
    });

    return {
      success: true,
      guide: response.response.trim()
    };
  } catch (error) {
    console.error('Error generating guide:', error);
    return {
      success: false,
      error: error.message
    };
  }
} 