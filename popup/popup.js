// Load saved preferences
chrome.storage.sync.get(['style', 'tone'], (prefs) => {
  document.getElementById('style').value = prefs.style || 'formal';
  document.getElementById('tone').value = prefs.tone || 'neutral';
});

// Save preferences
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', () => {
    chrome.storage.sync.set({
      style: document.getElementById('style').value,
      tone: document.getElementById('tone').value
    });
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