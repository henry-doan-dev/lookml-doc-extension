# LookML Explore Doc

Extension VS Code dùng để sinh tài liệu Excel cho các explore LookML. Mọi thứ chạy **offline**: extension chỉ đọc file `.lkml` trong máy, không gọi Looker API.

## Cài đặt

1. Mở VS Code, vào Extensions, chọn `...`, rồi **Install from VSIX...**.
2. Chọn file `lookml-explore-doc-0.1.0.vsix`.

## Sử dụng

| Cách | Mô tả |
|---|---|
| CodeLens **Generate Doc (Excel)** | Hiện phía trên mỗi dòng `explore: xxx {`. Bấm vào để xuất explore đó |
| `LookML Doc: Generate Explore Documentation` | Chọn model, rồi chọn explore |
| `LookML Doc: Generate Documentation for All Explores in a Model` | Chọn model, rồi chọn nhiều explore. Mỗi explore được xuất ra một sheet |

Mặc định file Excel được lưu ở **thư mục cha của workspace**, tức nằm ngoài repo LookML, để không ảnh hưởng tới git.

## Cấu hình (`settings.json`)

```jsonc
{
  // Bắt buộc để có đầy đủ thông tin cho các view của hub (dmc_office, dmc_svc_scp, ...)
  "lookmlDoc.remoteProjects": {
    "one-hub": "D:/CLT/lookml_one_hub"   // clone repo hub về và checkout đúng commit `ref` trong manifest.lkml
  },
  "lookmlDoc.outputDir": "",              // để trống thì dùng thư mục cha của workspace
  "lookmlDoc.codeLens": true
}
```

Tên project trong `//xxx/...` mà không được khai báo trong `manifest.lkml` (ví dụ `//one-crm-spoke/`) được hiểu là chính project hiện tại.

## Các cột trong file Excel

| Cột | Nguồn |
|---|---|
| Looker Label | `label` (đã render Liquid và `@{constant}`). Nếu không có thì lấy tên field dạng Title Case. Với timeframe thì là `label` + tên timeframe |
| Looker View Label | Lấy giá trị đầu tiên có trong thứ tự: `view_label` của field → `view_label` của join/explore → `view_label`/`label` của view → tên alias |
| Looker Group Label / Group Item Label | `group_label` / `group_item_label` (đã render). Không có `group_label` thì để trống; không có `group_item_label` thì lấy giá trị của Looker Label |
| Category | `dimension` (gồm cả dimension_group) / `measure` / `parameter` / `filter` |
| Key / View Name / Field Identifier | `<view gốc>.<field>` / view gốc / tên field (kèm hậu tố timeframe nếu có) |
| Mart Table / View, Mart Column | Lần đệ quy `${...}` → `${TABLE}.col` → SQL của derived table (gồm CTE, UNION, subquery, PIVOT, `${view.SQL_TABLE_NAME}`, `sql_table_name: (SELECT ...)`, `explore_source`) cho tới bảng BigQuery gốc |
| BIZ Logic for LM | Chỉ ghi khi field có biến đổi ở bất kỳ tầng nào. Nếu chỉ là `${TABLE}.col`, `${field}` hoặc `${view.field}` thì để trống. Biến đổi nằm ở tầng sâu hơn được ghi kèm vị trí, ví dụ `[dmo_usr.full_nm]` hoặc `[view (derived_table)]`. Measure có `filters` cũng được ghi lại |

Field bị loại khỏi tài liệu nếu: có `hidden: yes` (tính sau khi đã gộp extends và refinement), không nằm trong `fields:` của explore hoặc join, hoặc là timeframe `raw`.

Sheet **Warnings** liệt kê những gì chưa trace được, ví dụ view của hub chưa map hoặc cột không tìm thấy trong SQL.

## Phát triển

```bash
npm install
npm run compile
# chạy thử bằng CLI, không cần VS Code
node out/cli.js --root D:/CLT/LOOKML_one_crm_spoke --model customer_relationship_sales_cloud_restricted --explore opportunity --out D:/CLT/opportunity.xlsx
# debug trong VS Code: nhấn F5 (cấu hình trong .vscode/launch.json)
npm run package   # tạo file .vsix
```

Cấu trúc thư mục `src/core` (không phụ thuộc VS Code):

- `parser.ts`: parse LookML thành AST
- `project.ts`: xử lý include, glob, `//project/` và constant trong manifest
- `model.ts`: gộp view (base + refinement + extends) và dựng explore
- `sql.ts`: phân tích SELECT của BigQuery (CTE, UNION, subquery, PIVOT)
- `lineage.ts`: lần lineage và lấy business logic
- `liquid.ts`: render Liquid cho label
- `document.ts`: lọc field hidden và dựng từng dòng tài liệu
- `excel.ts`: xuất file Excel
