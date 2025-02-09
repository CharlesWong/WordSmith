// Default settings
const DEFAULT_SETTINGS = {
  style: 'formal',
  tone: 'neutral',
  ollamaAddress: 'http://localhost:11434',
  ollamaModel: 'llama2',
  simpleMode: true  // Default to simple mode
};

// Load saved preferences from local storage using the "grammarSettings" key
chrome.storage.local.get(['grammarSettings'], (result) => {
  const settings = { ...DEFAULT_SETTINGS, ...result.grammarSettings };
  document.getElementById('style').value = settings.style;
  document.getElementById('tone').value = settings.tone;
  document.getElementById('ollamaAddress').value = settings.ollamaAddress;
  document.getElementById('ollamaModel').value = settings.ollamaModel;
  document.getElementById('experienceMode').checked = !settings.simpleMode;
});

// Save preferences on change using updateSettings
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', () => {
    const newSettings = {
      style: document.getElementById('style').value,
      tone: document.getElementById('tone').value
    };
    updateSettings(newSettings);
  });
});

// Check Ollama connection
function checkConnection() {
  const status = document.getElementById('status');
  const reconnectBtn = document.getElementById('reconnect');
  
  status.textContent = 'Checking connection...';
  status.className = 'status-indicator checking';
  
  chrome.runtime.sendMessage({ action: 'checkConnection' }, (response) => {
    if (response.success) {
      status.textContent = 'Connected to Ollama ✅';
      status.className = 'status-indicator connected';
      reconnectBtn.classList.add('hidden');
    } else {
      status.textContent = `Connection failed: ${response.error}`;
      status.className = 'status-indicator error';
      reconnectBtn.classList.remove('hidden');
    }
  });
}

// Add reconnect button handler
document.getElementById('reconnect').addEventListener('click', checkConnection);

// Check connection on popup open
checkConnection();

// When settings change
function updateSettings(newSettings) {
  chrome.storage.local.set({ grammarSettings: newSettings }, () => {
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
}

// Store custom guides
let customGuides = {
  styles: {},
  tones: {}
};

// Load custom guides from storage
chrome.storage.local.get(['customGuides'], (result) => {
  if (result.customGuides) {
    customGuides = result.customGuides;
    updateCustomOptions();
  }
});

// Update select dropdowns with custom options
function updateCustomOptions() {
  const styleSelect = document.getElementById('style');
  const toneSelect = document.getElementById('tone');

  // Clear existing custom options
  Array.from(styleSelect.options).forEach(option => {
    if (option.dataset.custom) {
      styleSelect.removeChild(option);
    }
  });

  Array.from(toneSelect.options).forEach(option => {
    if (option.dataset.custom) {
      toneSelect.removeChild(option);
    }
  });

  // Add custom styles
  Object.keys(customGuides.styles).forEach(styleName => {
    const option = document.createElement('option');
    option.value = styleName;
    option.textContent = styleName;
    option.dataset.custom = 'true';
    styleSelect.appendChild(option);
  });

  // Add custom tones
  Object.keys(customGuides.tones).forEach(toneName => {
    const option = document.createElement('option');
    option.value = toneName;
    option.textContent = toneName;
    option.dataset.custom = 'true';
    toneSelect.appendChild(option);
  });
}

// Handle custom style form
document.getElementById('addCustomStyle').addEventListener('click', () => {
  document.getElementById('customStyleForm').classList.remove('hidden');
});

document.getElementById('saveCustomStyle').addEventListener('click', async () => {
  const name = document.getElementById('customStyleName').value.trim();
  const guide = document.getElementById('customStyleGuide').value.trim();

  if (!name || !guide) {
    alert('Please fill in both name and guide');
    return;
  }

  // Generate guide using Ollama
  const response = await chrome.runtime.sendMessage({
    action: 'generateGuide',
    type: 'style',
    name: name,
    description: guide
  });

  if (response.success) {
    customGuides.styles[name] = response.guide;
    chrome.storage.local.set({ customGuides });
    updateCustomOptions();
    document.getElementById('customStyleForm').classList.add('hidden');
    document.getElementById('customStyleName').value = '';
    document.getElementById('customStyleGuide').value = '';
  }
});

// Similar handlers for custom tone
document.getElementById('addCustomTone').addEventListener('click', () => {
  document.getElementById('customToneForm').classList.remove('hidden');
});

document.getElementById('saveCustomTone').addEventListener('click', async () => {
  const name = document.getElementById('customToneName').value.trim();
  const guide = document.getElementById('customToneGuide').value.trim();

  if (!name || !guide) {
    alert('Please fill in both name and guide');
    return;
  }

  // Generate guide using Ollama
  const response = await chrome.runtime.sendMessage({
    action: 'generateGuide',
    type: 'tone',
    name: name,
    description: guide
  });

  if (response.success) {
    customGuides.tones[name] = response.guide;
    chrome.storage.local.set({ customGuides });
    updateCustomOptions();
    document.getElementById('customToneForm').classList.add('hidden');
    document.getElementById('customToneName').value = '';
    document.getElementById('customToneGuide').value = '';
  }
});

// Save all settings when changed
function saveSettings(additionalSettings = {}) {
  const newSettings = {
    ...DEFAULT_SETTINGS,  // Start with defaults
    style: document.getElementById('style').value,
    tone: document.getElementById('tone').value,
    ollamaAddress: document.getElementById('ollamaAddress').value,
    ollamaModel: document.getElementById('ollamaModel').value,
    ...additionalSettings  // Allow overriding with additional settings
  };

  chrome.storage.local.set({ grammarSettings: newSettings }, () => {
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
}

// Add event listeners for all settings changes
document.querySelectorAll('select, input').forEach(element => {
  element.addEventListener('change', () => {
    saveSettings();
  });
});

// Test connection button
document.getElementById('testConnection').addEventListener('click', async () => {
  const status = document.getElementById('connectionStatus');
  status.textContent = 'Testing connection...';
  status.className = '';
  const selectedModel = document.getElementById('ollamaModel').value;
  const ollamaAddress = document.getElementById('ollamaAddress').value;
  
  try {
    const response = await chrome.runtime.sendMessage({ 
      action: 'checkConnection',
      model: selectedModel,
      address: ollamaAddress
    });
    
    if (response.success) {
      if (response.modelAvailable) {
        status.textContent = `Connected successfully! Model "${selectedModel}" is available.`;
      } else {
        status.textContent = `Connected to Ollama, but model "${selectedModel}" is not installed. Run: ollama pull ${selectedModel}`;
        status.className = 'warning';
      }
      status.className = 'success';
    } else {
      status.textContent = response.error || 'Connection failed';
      status.className = 'error';
    }
  } catch (error) {
    status.textContent = 'Connection failed: ' + error.message;
    status.className = 'error';
  }
});

// Add toggle handler
document.getElementById('experienceMode').addEventListener('change', (event) => {
  saveSettings({ simpleMode: !event.target.checked });
}); 