console.log('▶️ Pack-slip extractor starting…');

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    const anchors = Array.from(
        document.querySelectorAll('a[href*="downloadFile.do?fileId="]')
    ).filter(a => !a.href.includes('authorize'));

    if (!anchors.length) {
        return alert('⚠️ No download links found!');
    }
    console.log(`Found ${anchors.length} pack-slips.`);

    // ✅ Step 1: Fetch existing purchaseOrders from Sheet
    const existingPOsResp = await new Promise(res =>
        chrome.runtime.sendMessage({ action: 'getExistingPOs' }, res)
    );
    if (!existingPOsResp.success) {
        return alert('❌ Failed to fetch existing PO list.');
    }
    const existingPOs = existingPOsResp.data || [];
    const normalizePO = po => po?.toString().replace(/^0+/, '').slice(-12);
    const normalizedPOList = existingPOs.map(normalizePO);
    console.log(`Loaded ${normalizedPOList.length} existing purchase orders`);

    let processedCount = 0;
    const MAX_PO = 100;

    // ✅ Step 2: Extract data and post only if PO is not in list
    for (const a of anchors) {
        try {
            const fetchResp = await new Promise(res =>
                chrome.runtime.sendMessage({ action: 'fetchPdf', url: a.href }, res)
            );
            if (!fetchResp.success) {
                console.error('PDF fetch failed:', fetchResp.error);
                continue;
            }

            const buf = Uint8Array.from(atob(fetchResp.data), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

            let text = '';
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                text += content.items.map(it => it.str).join('\n') + '\n';
            }

            const orders = text.split(/PACKING LIST[\s\S]*?PURCHASE ORDER \/ BON DE COMMANDE/g);
            for (const block of orders) {
                if (processedCount >= MAX_PO) break;
                if (!block.trim()) continue;

                const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
                let colD = '', colE = '', colG = '', colH = '', colI = '', colL = '';

                for (let i = 0; i < lines.length; i++) {
                    if (!colD && /^\d{8,}$/.test(lines[i])) colD = lines[i];
                    if (!colE && lines[i].toLowerCase().includes("description")) {
                        colE = lines[i + 2]?.match(/\d{6,}/)?.[0] || '';
                    }
                    if (!colI && lines[i].toLowerCase().includes("description")) {
                        colI = lines[i + 1]?.match(/^\d+$/)?.[0] || '';
                    }
                    if (!colG && lines[i].toLowerCase().includes("costco item")) {
                        colG = lines[i - 1]?.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || '';
                    }
                    if (!colL && lines[i].toLowerCase().includes("ship to") && lines[i].includes(':')) {
                        colL = lines[i + 1]?.trim() || '';
                    }
                    if (!colH && lines[i].toLowerCase().includes("vendu à")) {
                        const targetLine = lines[i + 3] || '';
                        const match = targetLine.match(/,\s*([A-Z]{2})\b/) || targetLine.match(/\b([A-Z]{2})\b/);
                        if (match) colH = match[1];
                    }
                }

                const cleanPO = normalizePO(colD);
                if (cleanPO && !normalizedPOList.includes(cleanPO)) {
                    console.log(`✅ New PO ${colD}, sending...`);
                    processedCount++;

                    await sleep(1000); // delay between posts
                    await new Promise(resolve => {
                        chrome.runtime.sendMessage(
                            {
                                action: 'postData',
                                payload: {
                                    purchaseOrder: cleanPO,
                                    itemNumber: colE,
                                    orderDate: colG,
                                    province: colH,
                                    quantity: colI,
                                    shipTo: colL
                                }
                            },
                            resp => {
                                if (!resp?.success && resp?.status !== 'skipped') {
                                    console.error('❌ POST failed:', resp?.error || resp);
                                } else {
                                    console.log(`⬆️ Submitted PO ${colD}`);
                                }
                                resolve();
                            }
                        );
                    });
                } else if (colD) {
                    console.log(`⏭️ Skipped duplicate PO ${colD}`);
                    processedCount++;
                }
            }

            if (processedCount >= MAX_PO) break;
        } catch (err) {
            console.error('❌ Unexpected error:', err);
        }
    }

    console.log('🔁 All POs submitted. Updating PO status...');

    await new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: 'triggerUpdate' },
            resp => {
                if (resp?.success) {
                    console.log('✅ updatePOStatus triggered once at end');
                } else {
                    console.error('❌ Failed to trigger updatePOStatus:', resp?.error);
                }
                resolve();
            }
        );
    });

    alert(`✅ Done! Processed ${processedCount} pack-slip(s).`);
})();