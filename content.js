console.log('▶️ Pack-slip extractor starting…');

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    const anchors = Array.from(
        document.querySelectorAll('a[href*="downloadFile.do?fileId="]')
    ).filter(a => !a.href.includes('authorize'));

    if (!anchors.length) {
        return alert('⚠️ No download links found!');
    }
    console.log(`Found ${anchors.length} pack-slips.`);

    // 1) Fetch the list of existing POs from the background
    const existing = await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'getExistingPOs' }, r)
    );
    if (!existing.success) {
        return alert('❌ Failed to fetch existing PO list.');
    }
    const normalizePO = po => po?.toString().replace(/^0+/, '').slice(-12);
    const seenPOs = (existing.data || []).map(normalizePO);

    let processed = 0;
    const MAX_PO = 300;

    for (const a of anchors) {
        if (processed >= MAX_PO) break;

        try {
            // 2) Fetch the PDF binary via the background script
            const pdfResp = await new Promise(r =>
                chrome.runtime.sendMessage({ action: 'fetchPdf', url: a.href }, r)
            );
            if (!pdfResp.success) {
                console.error('PDF fetch failed:', pdfResp.error);
                continue;
            }

            const buf = Uint8Array.from(atob(pdfResp.data), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

            // 3) Concatenate the text of every page
            let fullText = '';
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                fullText += content.items.map(i => i.str).join('\n') + '\n';
            }

            // 4) Split into each “PACKING LIST” section
            const sections = [];
            const secRe = /(?:LISTE D'ENVOI\s*\/\s*PACKING LIST|PACKING LIST)[\s\S]*?(?=(?:LISTE D'ENVOI\s*\/\s*PACKING LIST|PACKING LIST)|$)/gi;
            let m;
            while ((m = secRe.exec(fullText))) {
                sections.push(m[0]);
            }
            console.log(`→ ${sections.length} sections found in this PDF`);

            // 5) Extract fields from each section and send them
            for (const block of sections) {
                if (processed >= MAX_PO) break;
                if (!block.trim()) continue;

                // rawLines keeps every line (including empty ones), which we’ll use by index to match quantities and item numbers
                const rawLines = block.split('\n');
                // lines removes empty lines, used for extracting PO, date, province, shipTo
                const lines = rawLines
                    .map(l => l.trim())
                    .filter(Boolean);

                let colD = '', // PO
                    colE = '', // itemNumber(s), multiple items joined with '&'
                    colG = '', // orderDate
                    colH = '', // province
                    colI = '', // quantity(ies), multiple quantities joined with '&'
                    colL = ''; // shipTo

                // ===== ① —— First locate the index of the first line containing “description” =====
                let postDesc = '';
                const descLineIdx = rawLines.findIndex(l =>
                    l.trim().toLowerCase().includes('description')
                );
                if (descLineIdx !== -1) {
                    // After the DESCRIPTION line, join all lines into one large string
                    postDesc = rawLines.slice(descLineIdx + 1).join('\n');
                }

                // ===== ② —— Handle both “combined line” and “split line” formats =====
                const items = [];
                const qtys = [];

                if (postDesc) {
                    const postLines = postDesc.split('\n').map(s => s.trim());

                    // ---- 2.1 Combined-line case: single line like "11464583" or "11464589" ----
                    for (const line of postLines) {
                        const mCombo = line.match(/^(\d)(\d{7})$/);
                        if (mCombo) {
                            qtys.push(mCombo[1]);
                            items.push(mCombo[2]);
                        }
                    }

                    // ---- 2.2 Split-line case: one line is quantity (e.g., "1"), next line is a 7-digit item number ----
                    for (let i = 0; i < postLines.length - 1; i++) {
                        const cur = postLines[i];
                        const nxt = postLines[i + 1];
                        if (/^\d$/.test(cur) && /^\d{7}$/.test(nxt)) {
                            // The combined-line matches have already been handled above; here we only care about single-digit + 7-digit split lines
                            // If this pair hasn’t been captured by a combined-line match, collect it
                            const itemNum = nxt;
                            const qty = cur;
                            // Prevent duplicates: only add if items doesn’t already include this itemNum
                            if (!items.includes(itemNum)) {
                                qtys.push(qty);
                                items.push(itemNum);
                            }
                        }
                    }

                    if (items.length) {
                        colE = items.join('&'); // e.g. "1464583&1464589"
                        colI = qtys.join('&');  // e.g. "1&1"
                    }
                }

                // ===== ③ —— If no itemNumber was extracted, fallback to the old dataRow rule =====
                if (!colE) {
                    const dataRow = lines.find(l => {
                        const parts = l.split(/\s+/);
                        return parts.length >= 3
                            && /^\d{6,}$/.test(parts[0])
                            && /^\d{6,}$/.test(parts[1])
                            && /^\d+$/.test(parts[2]);
                    });
                    if (dataRow) {
                        const [, vendorRef, qty] = dataRow.split(/\s+/);
                        colE = vendorRef;
                        colI = qty;
                    }
                }

                // ===== ④ —— Scan lines to extract PO, orderDate, province, shipTo =====
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const low = line.toLowerCase();

                    // —— Purchase Order —— purely numeric and length >= 8
                    if (!colD && /^\d{8,}$/.test(line)) {
                        colD = line;
                    }

                    // —— orderDate —— when the line contains “costco item,” the previous line usually has “MM/DD/YYYY”
                    if (!colG && low.includes('costco item')) {
                        const prev = lines[i - 1] || '';
                        const mDate = prev.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                        if (mDate) {
                            colG = mDate[1];
                        }
                    }

                    // —— province —— when the line contains “vendu à,” 3–4 lines below usually contain the province code
                    if (!colH && low.includes('vendu à')) {
                        const PROV_REGEX = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/;
                        for (let offset of [3, 4]) {
                            const cand = lines[i + offset] || '';
                            const mProv = cand.match(PROV_REGEX);
                            if (mProv) {
                                colH = mProv[1];
                                break;
                            }
                        }
                    }

                    // —— shipTo —— if the line contains “ship to:”, the next line is the address
                    if (!colL && low.includes('ship to') && line.includes(':')) {
                        colL = lines[i + 1]?.trim() || '';
                    }
                }

                // ===== ⑤ —— (Fallback) If still no itemNumber, use the last 7-digit number in the block =====
                if (!colE) {
                    const fallback7 = block.match(/\b\d{7}\b/g) || [];
                    if (fallback7.length) {
                        colE = fallback7[fallback7.length - 1];
                    }
                }

                // ===== ⑥ —— (Fallback) If still no orderDate, extract it from the line above “DESCRIPTION” =====
                if (!colG) {
                    const descIdx2 = lines.findIndex(l => l.toLowerCase().includes('description'));
                    if (descIdx2 > 0) {
                        const prev = lines[descIdx2 - 1];
                        const mDate2 = prev.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                        if (mDate2) {
                            colG = mDate2[1];
                        }
                    }
                }

                const cleanPO = normalizePO(colD);
                if (cleanPO && !seenPOs.includes(cleanPO)) {
                    console.log(`✅ New PO ${colD}, sending (items=${colE}, date=${colG})…`);
                    processed++;

                    await sleep(1000);
                    await new Promise(r => {
                        chrome.runtime.sendMessage({
                            action: 'postData',
                            payload: {
                                purchaseOrder: cleanPO,
                                itemNumber: colE,
                                orderDate: colG,
                                province: colH,
                                quantity: colI,
                                shipTo: colL
                            }
                        }, resp => {
                            if (!resp?.success && resp?.status !== 'skipped') {
                                console.error('❌ POST failed:', resp?.error || resp);
                            } else {
                                console.log(`⬆️ Submitted PO ${colD}`);
                            }
                            r();
                        });
                    });
                } else if (colD) {
                    console.log(`⏭️ Skipped duplicate PO ${colD}`);
                    processed++;
                }
            }
        } catch (err) {
            console.error('❌ Unexpected error:', err);
        }
    }

    console.log('🔁 Triggering updatePOStatus…');
    await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'triggerUpdate' }, r)
    );

    alert(`✅ Done! Processed ${processed} pack-slip(s).`);
})();
