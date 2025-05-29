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

    // Step 1: fetch existing PO list
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
            // fetch PDF bytes
            const pdfResp = await new Promise(r =>
                chrome.runtime.sendMessage({ action: 'fetchPdf', url: a.href }, r)
            );
            if (!pdfResp.success) {
                console.error('PDF fetch failed:', pdfResp.error);
                continue;
            }

            const buf = Uint8Array.from(atob(pdfResp.data), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

            // extract every page's text
            let fullText = '';
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                fullText += content.items.map(i => i.str).join('\n') + '\n';
            }

            // split into PACKING LIST sections
            const sections = [];
            const secRe = /(?:LISTE D'ENVOI\s*\/\s*PACKING LIST|PACKING LIST)[\s\S]*?(?=(?:LISTE D'ENVOI\s*\/\s*PACKING LIST|PACKING LIST)|$)/gi;
            let m;
            while ((m = secRe.exec(fullText))) {
                sections.push(m[0]);
            }
            console.log(`→ ${sections.length} sections found in this PDF`);

            for (const block of sections) {
                if (processed >= MAX_PO) break;
                if (!block.trim()) continue;

                const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

                let colD = '', // PO
                    colE = '', // itemNumber / vendorRef
                    colG = '', // orderDate
                    colH = '', // province
                    colI = '', // quantity
                    colL = ''; // shipTo

                // 1) Direct data-row parse
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

                // 2) Per-line scan for PO, provisional date, province, shipTo
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const low = line.toLowerCase();

                    // Purchase Order
                    if (!colD && /^\d{8,}$/.test(line)) {
                        colD = line;
                    }

                    // Date from header fallback — capture only MM/DD/YYYY
                    if (!colG && low.includes('costco item')) {
                        const raw = lines[i - 1] || '';
                        const mDate = raw.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                        if (mDate) colG = mDate[1];
                    }

                    // Province
                    if (!colH && low.includes('vendu à')) {
                        const tgt = lines[i + 3] || '';
                        const mProv = tgt.match(/,\s*([A-Z]{2})\b/) || tgt.match(/\b([A-Z]{2})\b/);
                        if (mProv) colH = mProv[1];
                    }

                    // Ship To
                    if (!colL && low.includes('ship to') && line.includes(':')) {
                        colL = lines[i + 1]?.trim() || '';
                    }
                }

                // 3) Fallback for colE: last 6–7 digit run
                if (!colE) {
                    const allNums = block.match(/\b\d{6,7}\b/g) || [];
                    if (allNums.length) {
                        colE = allNums[allNums.length - 1];
                    }
                }

                // 4) Fallback for colG: line immediately before “DESCRIPTION”
                if (!colG) {
                    const descIdx = lines.findIndex(l => /^description/i.test(l));
                    if (descIdx > 0) {
                        const prev = lines[descIdx - 1];
                        const mDate = prev.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                        if (mDate) colG = mDate[1];
                    }
                }

                const cleanPO = normalizePO(colD);
                if (cleanPO && !seenPOs.includes(cleanPO)) {
                    console.log(`✅ New PO ${colD}, sending (item=${colE}, date=${colG})…`);
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
