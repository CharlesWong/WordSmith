// Load saved preferences from local storage using the "grammarSettings" key
chrome.storage.local.get(['grammarSettings'], (result) => {
  const settings = result.grammarSettings || { style: 'formal', tone: 'neutral' };
  document.getElementById('style').value = settings.style;
  document.getElementById('tone').value = settings.tone;
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