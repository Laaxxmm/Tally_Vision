/**
 * TallyVision - XML Report Templates (v4 - FIX-23)
 * Compatible with Tally Prime Gold
 * FIX-23: Daybook uses bare Collection API — NO filters, NO AllLedgerEntries.
 *   Tally SYSTEM Formulae (NOT $IsCancelled) crash some companies.
 *   AllLedgerEntries expansion causes timeout (15MB+ for 1 week).
 *   Filtering happens in JS after parsing.
 */

const companyBlock = (c) => c ? `<SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>` : '';

function xmlWrap(reportId, formId, partId, staticVars, tdlBody) {
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${reportId}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${staticVars}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="${reportId}"><FORMS>${formId}</FORMS></REPORT>
<FORM NAME="${formId}"><PARTS>${partId}</PARTS><XMLTAG>DATA</XMLTAG></FORM>
${tdlBody}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

const TEMPLATES = {

    'list-masters': (collection, company) => xmlWrap('TVList', 'TVListF', 'TVListP',
        companyBlock(company),
        `<PART NAME="TVListP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>${collection}</TYPE></COLLECTION>`
    ),

    'chart-of-accounts': (company) => xmlWrap('TVCoA', 'TVCoAF', 'TVCoAP',
        companyBlock(company),
        `<PART NAME="TVCoAP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $IsRevenue then "PL" else "BS"</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>if $IsDeemedPositive then "D" else "C"</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>if $AffectsGrossProfit then "Y" else "N"</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Group</TYPE></COLLECTION>`
    ),

    'trial-balance': (fromDate, toDate, company) => xmlWrap('TVTB', 'TVTBF', 'TVTBP',
        `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
        `<PART NAME="TVTBP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05,F06</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$OpeningBalance then -$$NumValue:$OpeningBalance else $$NumValue:$OpeningBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>$$NumValue:$DebitTotals</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$CreditTotals</SET><XMLTAG>F05</XMLTAG></FIELD>
<FIELD NAME="F06"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F06</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
    ),

    'profit-loss': (fromDate, toDate, company) => xmlWrap('TVPL', 'TVPLF', 'TVPLP',
        `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
        `<PART NAME="TVPLP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
    ),

    'balance-sheet': (fromDate, toDate, company) => xmlWrap('TVBS', 'TVBSF', 'TVBSP',
        `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
        `<PART NAME="TVBSP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
    ),

    // FIX-23: Bare Collection API — NO filters, NO AllLedgerEntries.
    // SYSTEM Formulae (NOT $IsCancelled etc.) crash Tally Prime for some companies.
    // AllLedgerEntries expansion is too heavy (15MB+ for 1 week, timeout).
    // Solution: voucher-level fields only, caller filters in JS.
    // voucherType param kept for signature compat but ignored (no Tally-side filter).
    'daybook': (fromDate, toDate, company, _voucherType) => {
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TVDaybook</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="TVDaybook"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Amount,Narration</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    },

        'stock-summary': (fromDate, toDate, company) => xmlWrap('TVSS', 'TVSSF', 'TVSSP',
        `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
        `<PART NAME="TVSSP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05,F06,F07,F08,F09,F10</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>$$NumValue:$OpeningBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>$$NumValue:$OpeningValue</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$InwardQuantity</SET><XMLTAG>F05</XMLTAG></FIELD>
<FIELD NAME="F06"><SET>$$NumValue:$InwardValue</SET><XMLTAG>F06</XMLTAG></FIELD>
<FIELD NAME="F07"><SET>$$NumValue:$OutwardQuantity</SET><XMLTAG>F07</XMLTAG></FIELD>
<FIELD NAME="F08"><SET>$$NumValue:$OutwardValue</SET><XMLTAG>F08</XMLTAG></FIELD>
<FIELD NAME="F09"><SET>$$NumValue:$ClosingBalance</SET><XMLTAG>F09</XMLTAG></FIELD>
<FIELD NAME="F10"><SET>$$NumValue:$ClosingValue</SET><XMLTAG>F10</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>StockItem</TYPE></COLLECTION>`
    ),

    // ── OPTIONAL MODULE TEMPLATES ─────────────────────────────────────────────

    // Cost Centre master list — single request
    'cost-centres': (company) => xmlWrap('TVCostCtr', 'TVCostCtrF', 'TVCostCtrP',
        companyBlock(company),
        `<PART NAME="TVCostCtrP"><LINES>L1</LINES><REPEAT>L1:CCostCtr</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>$Category</SET><XMLTAG>F03</XMLTAG></FIELD>
<COLLECTION NAME="CCostCtr"><TYPE>CostCentre</TYPE></COLLECTION>`
    ),

    // Cost Allocations — period totals per ledger + cost centre using WALK.
    // TYPE=Ledger → WALK=CostCentreDetails gives each ledger's cost centre split.
    // VARIABLE captures ledger name before walking into CostCentreDetails.
    // If cost centres are disabled, Tally returns empty rows — safe.
    'cost-allocations': (fromDate, toDate, company) => {
        const SC = '<' + '/SYSTEM>';
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVCostAlloc</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVCostAlloc"><FORMS>TVCostAllocF</FORMS></REPORT>
<FORM NAME="TVCostAllocF"><PARTS>TVCostAllocP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVCostAllocP"><LINES>TVCostAllocL</LINES><REPEAT>TVCostAllocL:CCostAlloc</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="TVCostAllocL"><FIELDS>F01,F02,F03,F04</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>##CurLedName</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$CostCentreName</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>$Category</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount</SET><XMLTAG>F04</XMLTAG></FIELD>
<COLLECTION NAME="CCostAlloc"><TYPE>Ledger</TYPE>
<VARIABLE>CurLedName</VARIABLE><WALK>CostCentreDetails</WALK>
<FILTERS>TVCostNonZero</FILTERS></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="TVCostNonZero">$$NumValue:$Amount != 0${SC}
<VARIABLE NAME="CurLedName" USE="Name Field"/>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    },

    // Stock Item Ledger — per-item transaction statement using NATIVEMETHOD AllInventoryEntries.
    // On-demand only (not in runFullSync). itemName must be exact Tally stock item name.
    // FIX-23: Removed SYSTEM Formulae filters (crash Tally Prime for some companies).
    'stock-item-ledger': (fromDate, toDate, company) => {
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TVStockLedger</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="TVStockLedger"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Amount</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    },

    // ── BILLS OUTSTANDING ─────────────────────────────────────────────────────
    'bills-outstanding': (toDate, nature, company) => {
        const groupName = nature.toLowerCase().startsWith('r') ? 'Sundry Debtors' : 'Sundry Creditors';
        const SC = '<' + '/SYSTEM>';
        // WALK flattens Ledger→BillAllocations into one collection.
        // VARIABLE captures the parent Ledger name before walking each ledger's bills.
        // REPEAT is on PART (the only valid location in TDL — not LINE).
        // $$IsBlank guard prevents $$Age crash on bills with no date.
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVBills</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVBills"><FORMS>TVBillsF</FORMS></REPORT>
<FORM NAME="TVBillsF"><PARTS>TVBillsP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVBillsP"><LINES>TVBillsL</LINES><REPEAT>TVBillsL:CBills</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="TVBillsL"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$BillDate</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Name</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>##CurLedName</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>if $$IsBlank:$BillDate then 0 else $$NumValue:$$Age:$BillDate:$$AsOnDate</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="CBills"><TYPE>Ledger</TYPE><CHILDOF>${groupName}</CHILDOF>
<VARIABLE>CurLedName</VARIABLE><WALK>BillAllocations</WALK>
<FILTERS>TVBillOutstanding</FILTERS></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="TVBillOutstanding">$$NumValue:$Amount != 0${SC}
<VARIABLE NAME="CurLedName" USE="Name Field"/>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    }
};

module.exports = { TEMPLATES, companyBlock };



