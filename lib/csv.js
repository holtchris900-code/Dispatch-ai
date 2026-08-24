// A small, dependency-free CSV parser -- just enough to handle a customer
// list exported from Excel, Google Sheets, or Numbers (the realistic source
// for a home services business owner). Handles quoted fields, commas and
// newlines inside quotes, and "" as an escaped quote inside a quoted field,
// which covers the vast majority of real-world exports without pulling in
// an npm dependency.
//
// Returns an array of plain objects keyed by the header row. Blank rows
// (no non-empty cells) are skipped entirely rather than turned into a row
// of empty strings.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const str = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inQuotes) {
      if (char === '"') {
        if (str[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  // Last field/row (files don't always end with a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const rawRow = rows[i];
    const hasContent = rawRow.some((cell) => cell.trim() !== '');
    if (!hasContent) continue;

    const record = {};
    headers.forEach((header, colIdx) => {
      record[header] = (rawRow[colIdx] || '').trim();
    });
    records.push(record);
  }

  return records;
}

module.exports = { parseCsv };
