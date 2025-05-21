// background.js

// New Apps Script Web App URL (deployed as "Anyone, even anonymous")
const SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbyig9Ex1h1vwMf20AlxrtS6G1llSWVAfNoSjfGTSQTI90e7nBMATWPN1LuUpaC_wIaIEQ/exec';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'fetchPdf') {
        fetch(msg.url, { credentials: 'include' })
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('application/pdf')) throw new Error('Not a PDF: ' + ct);
                return r.arrayBuffer();
            })
            .then(buf => {
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let b of bytes) bin += String.fromCharCode(b);
                sendResponse({ success: true, data: btoa(bin) });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (msg.action === 'postData') {
        fetch(SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.payload)
        })
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(_ => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
    if (msg.action === 'getExistingPOs') {
        fetch(SCRIPT_URL + '?mode=getPOs')
            .then(r => r.json())
            .then(data => sendResponse({ success: true, data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
    if (msg.action === 'triggerUpdate') {
        fetch(SCRIPT_URL + '?mode=update', {
            method: 'POST'
        })
            .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

});