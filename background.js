// Single endpoint for Ollama
const OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';
const DEFAULT_MODEL = 'llama3.2';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

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

  async getSuggestions(text, preferences) {
    console.log('Getting suggestions for text:', text.substring(0, 50) + '...');
    
    try {
      const prompt = this.createAnalysisPrompt(text, preferences);
      console.log('Sending prompt to Ollama...');
      
      const data = await this.callOllama({
        model: DEFAULT_MODEL,
        prompt: prompt,
        stream: false,
        options: { temperature: 0.2 }
      });

      if (!data.response) {
        throw new Error('Invalid response from Ollama');
      }

      // Parse the initial suggestions
      const parsedSuggestions = this.parseResponse(data.response);
      console.log('Initial parsed suggestions:', parsedSuggestions);
      
      // Deduplicate suggestions
      const deduplicatedSuggestions = await this.deduplicateSuggestions(parsedSuggestions);
      console.log('Deduplicated suggestions:', deduplicatedSuggestions);
      
      return deduplicatedSuggestions;
    } catch (error) {
      console.error('Error in getSuggestions:', error);
      throw error;
    }
  }

  parseResponse(text) {
    try {
      console.log('Starting to parse response text:', text);
      
      const categories = {
        grammar: [],
        style: [],
        tone: []
      };
      
      const lines = text.split('\n');
      let currentCategory = null;
      let currentSuggestion = {};
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        if (!trimmedLine) continue;
        
        // Check for category headers
        if (trimmedLine.toLowerCase().includes('grammar issues')) {
          currentCategory = 'grammar';
          continue;
        } else if (trimmedLine.toLowerCase().includes('style issues')) {
          currentCategory = 'style';
          continue;
        } else if (trimmedLine.toLowerCase().includes('tone issues')) {
          currentCategory = 'tone';
          continue;
        }

        if (!currentCategory) continue;

        // Parse suggestion components
        if (trimmedLine.startsWith('Original:')) {
          if (currentSuggestion.text && currentSuggestion.suggestion && currentCategory) {
            categories[currentCategory].push({...currentSuggestion});
          }
          currentSuggestion = {
            text: trimmedLine.replace('Original:', '').replace(/["\[\]]/g, '').trim()
          };
        } else if (trimmedLine.startsWith('Replace with:')) {
          if (currentSuggestion.text) {
            // Clean the replacement text to ensure it's just the exact replacement
            let replacement = trimmedLine.replace('Replace with:', '')
              .replace(/["\[\]]/g, '')  // Remove quotes and brackets
              .replace(/^(use|consider|try|you could use|replace with|change to)\s+/i, '')  // Remove common prefixes
              .replace(/\s+instead(\s+of.*)?$/i, '')  // Remove suffixes
              .trim();
            
            currentSuggestion.suggestion = replacement;
          }
        } else if (trimmedLine.startsWith('Reason:')) {
          if (currentSuggestion.text && currentSuggestion.suggestion) {
            currentSuggestion.explanation = trimmedLine.replace('Reason:', '').trim();
            if (currentCategory) {
              categories[currentCategory].push({...currentSuggestion});
              currentSuggestion = {};
            }
          }
        }
      }

      // Add any remaining complete suggestion
      if (currentSuggestion.text && currentSuggestion.suggestion && currentCategory) {
        categories[currentCategory].push({...currentSuggestion});
      }

      // Log the final results
      console.log('Final parsed suggestions:', {
        grammar: categories.grammar.length,
        style: categories.style.length,
        tone: categories.tone.length,
        details: categories
      });

      return categories;
    } catch (error) {
      console.error('Error parsing response:', error);
      console.error('Raw text that failed parsing:', text);
      return { grammar: [], style: [], tone: [] };
    }
  }

  createAnalysisPrompt(text, preferences) {
    const prompt = `As a professional writing assistant, analyze this text and suggest improvements:
Text: "${text}"

Provide suggestions in EXACTLY this format, focusing on direct text replacements:

**Grammar Issues**
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

**Style Issues**
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

**Tone Issues**
Original: "[exact text to replace]"
Replace with: "[exact replacement only]"
Reason: [brief explanation]

Rules:
1. Use EXACTLY the format shown above
2. Original text must be an exact substring from input
3. Replace with must contain ONLY the exact text to insert - no quotes, context, or explanations
4. Each suggestion must be a direct 1:1 replacement
5. Skip categories if no issues found
6. Do not add any extra text or formatting
7. Do not use phrases like "you could use" or "consider using"
8. Do not provide multiple options
9. Do not repeat suggestions across categories

Examples of good replacements:
✓ Original: "very big"
  Replace with: "enormous"

✗ Original: "very big"
  Replace with: "you could use 'enormous' instead"

✓ Original: "i think"
  Replace with: "I believe"

✗ Original: "i think"
  Replace with: "Consider using 'I believe' or 'I suppose'"`;

    debugLog('Created analysis prompt:', prompt);
    return prompt;
  }

  async deduplicateSuggestions(suggestions) {
    try {
      const prompt = `You are a JSON processing assistant. Your task is to deduplicate these writing suggestions and return them in the exact same JSON format:

${JSON.stringify(suggestions, null, 2)}

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
The response should start with { and end with }.

Example of correct response format:
{
  "grammar": [
    {
      "text": "you are bad",
      "suggestion": "You are bad.",
      "explanation": "Added capitalization and period for proper sentence structure"
    }
  ],
  "style": [
    {
      "text": "you are bad",
      "suggestion": "Your performance needs improvement",
      "explanation": "Uses more professional and constructive language"
    }
  ],
  "tone": []
}`;

      const data = await this.callOllama({
        model: DEFAULT_MODEL,
        prompt: prompt,
        stream: false,
        options: { 
          temperature: 0.1,
          stop: ["\n\n", "```"] // Add stop sequences to prevent extra text
        }
      });

      try {
        // Clean the response to ensure it's valid JSON
        let jsonStr = data.response.trim();
        // Remove any text before the first {
        jsonStr = jsonStr.substring(jsonStr.indexOf('{'));
        // Remove any text after the last }
        jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf('}') + 1);
        
        const deduplicated = JSON.parse(jsonStr);
        debugLog('Deduplicated suggestions:', deduplicated);
        return deduplicated;
      } catch (e) {
        console.error('Failed to parse deduplicated suggestions:', e);
        console.error('Raw response:', data.response);
        return suggestions;
      }
    } catch (error) {
      console.error('Error during deduplication:', error);
      return suggestions;
    }
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
});

// Log startup with timestamp
console.log('WriteWell background service worker initialized at:', new Date().toISOString());

debugLog('Starting background service...'); 