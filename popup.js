// popup.js

document.getElementById('run').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['pdf.js', 'pdf.worker.js', 'content.js']
    });
    window.close();
});