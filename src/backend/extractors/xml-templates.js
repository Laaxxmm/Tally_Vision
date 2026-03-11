/**
 * TallyVision - XML Report Templates (v3 - Daybook Fix)
 * Compatible with Tally Prime Gold
 * Fixed: Daybook uses WALK:AllLedgerEntries for actual amounts
 * Fixed: SYSTEM closing tags
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

    'daybook': (fromDate, toDate, company, voucherType) => {
        const SC = '<' + '/SYSTEM>';
        // NOTE: Tally's Collection API ignores SVFROMDATE/SVTODATE — it always returns
        // the currently-active Tally period's vouchers regardless of what date range is
        // requested. Date filtering is handled client-side via validRows in data-extractor.
        let filterNames = 'TVCancel,TVOptional';
        let filterBlock = '';
        if (voucherType) {
            filterNames += ',TVVchType';
            filterBlock = '<SYSTEM TYPE="Formulae" NAME="TVVchType">$VoucherTypeName = "' + voucherType + '"' + SC;
        }
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TVDaybook</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="TVDaybook"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Amount,Narration</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD>
<FILTER>${filterNames}</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="TVCancel">NOT $IsCancelled${SC}
<SYSTEM TYPE="Formulae" NAME="TVOptional">NOT $IsOptional${SC}
${filterBlock}
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

    'bills-outstanding': (toDate, nature, company) => {
        const groupName = nature.toLowerCase().startsWith('r') ? 'Sundry Debtors' : 'Sundry Creditors';
        const SC = '<' + '/SYSTEM>';
        return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVBills</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVBills"><FORMS>TVBillsF</FORMS></REPORT>
<FORM NAME="TVBillsF"><PARTS>TVBillsP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVBillsP"><LINES>TVBillsL</LINES><REPEAT>TVBillsL:CLedgers</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="TVBillsL"><PARTS>TVBillAllocP</PARTS></LINE>
<PART NAME="TVBillAllocP"><LINES>TVBillAllocL</LINES><REPEAT>TVBillAllocL:CBillAllocs</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="TVBillAllocL"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><USE>Short Date Field</USE><SET>$BillDate</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Name</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>##CurLedgerName</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$$Age:$BillDate:ToDate</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="CLedgers"><TYPE>Ledger</TYPE><CHILDOF>${groupName}</CHILDOF>
<VARIABLE>CurLedgerName</VARIABLE></COLLECTION>
<COLLECTION NAME="CBillAllocs"><TYPE>BillAllocations</TYPE><BELONGSTO>Yes</BELONGSTO>
<FILTERS>TVBillOutstanding</FILTERS></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="TVBillOutstanding">$$NumValue:$Amount != 0${SC}
<VARIABLE NAME="CurLedgerName" USE="Name Field"/>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    }
};

module.exports = { TEMPLATES, companyBlock };



