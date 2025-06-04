document.getElementById('run').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['pdf.js', 'pdf.worker.js', 'content.js']
    });
    // window.close(); // Keep popup open for logs
});

// On popup load, get log buffer
window.addEventListener('DOMContentLoaded', () => {
    chrome.runtime.sendMessage({ action: 'getLogs' }, response => {
        const logDiv = document.getElementById('log');
        if (response?.logs) {
            logDiv.textContent = response.logs.join('\n') + '\n';
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    });
});

// Listen for new logs
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'log') {
        const logDiv = document.getElementById('log');
        logDiv.textContent += request.message + '\n';
        logDiv.scrollTop = logDiv.scrollHeight;
    }
});