"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeWorkbook = writeWorkbook;
const exceljs_1 = __importDefault(require("exceljs"));
const document_1 = require("./document");
function sheetName(name, used) {
    const base = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
    let n = base;
    let i = 2;
    while (used.has(n.toLowerCase()))
        n = `${base.slice(0, 28)}_${i++}`;
    used.add(n.toLowerCase());
    return n;
}
/** Write one sheet per explore plus a Warnings sheet. */
async function writeWorkbook(docs, filePath) {
    const wb = new exceljs_1.default.Workbook();
    wb.creator = 'LookML Explore Doc';
    wb.created = new Date();
    const used = new Set();
    for (const doc of docs) {
        const ws = wb.addWorksheet(sheetName(doc.explore, used), { views: [{ state: 'frozen', ySplit: 1 }] });
        ws.columns = document_1.COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
        for (const row of doc.rows)
            ws.addRow(row);
        const header = ws.getRow(1);
        header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
        header.alignment = { vertical: 'middle', wrapText: true };
        header.height = 30;
        ws.eachRow((row, i) => {
            if (i === 1)
                return;
            row.alignment = { vertical: 'top', wrapText: true };
        });
        ws.getColumn('bizLogic').font = { name: 'Consolas', size: 9 };
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: document_1.COLUMNS.length } };
    }
    // one row per distinct warning, listing the explores it affects
    const byWarning = new Map();
    for (const d of docs) {
        for (const w of d.warnings) {
            const list = byWarning.get(w) ?? [];
            list.push(d.explore);
            byWarning.set(w, list);
        }
    }
    if (byWarning.size) {
        const ws = wb.addWorksheet(sheetName('Warnings', used), { views: [{ state: 'frozen', ySplit: 1 }] });
        ws.columns = [
            { header: 'Warning', key: 'warning', width: 140 },
            { header: 'Explores', key: 'explores', width: 50 },
        ];
        ws.getRow(1).font = { bold: true };
        for (const [warning, explores] of byWarning) {
            ws.addRow({ warning, explores: explores.length === docs.length && docs.length > 1 ? '(all)' : explores.join(', ') });
        }
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } };
    }
    await wb.xlsx.writeFile(filePath);
}
//# sourceMappingURL=excel.js.map