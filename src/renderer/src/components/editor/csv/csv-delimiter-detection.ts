export const CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS = 64 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

export function detectCsvDelimiter(filePath: string, content: string): string {
  if (filePath.toLowerCase().endsWith('.tsv')) {
    return '\t'
  }
  // Include semicolon spreadsheet exports without adding general importer heuristics.
  // Why: strip a leading UTF-8 BOM so it doesn't get counted as part of the
  // first cell's characters (and so BOM-prefixed TSVs still sniff correctly).
  let text = content
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  // Why: skip leading blank/whitespace-only lines before sniffing. A file that
  // starts with one or more empty lines would otherwise be classified as comma
  // (0 tabs vs 0 commas, tie goes to comma), misdetecting blank-leading TSVs.
  const firstLine = findFirstNonEmptyCsvSniffLine(text)
  const tabs = countDelimiterOutsideQuotes(firstLine, '\t')
  const semicolons = countDelimiterOutsideQuotes(firstLine, ';')
  const commas = countDelimiterOutsideQuotes(firstLine, ',')
  // Keep the existing comma/tab choice unless semicolon strictly wins.
  const existingDelimiter = tabs > commas ? '\t' : ','
  if (semicolons > commas && semicolons > tabs) {
    return hasConsistentExistingCsvColumns(text, existingDelimiter) ? existingDelimiter : ';'
  }
  return existingDelimiter
}

// Header punctuation should not replace an otherwise consistent comma/tab table.
function hasConsistentExistingCsvColumns(text: string, delimiter: string): boolean {
  const scanLength = Math.min(text.length, CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)
  const records: { delimiters: number; semicolons: number }[] = []
  let delimiters = 0
  let semicolons = 0
  let inQuotes = false
  let fieldIsEmpty = true
  let hasContent = false
  const pushRecord = (): void => {
    if (hasContent) {
      records.push({ delimiters, semicolons })
    }
    delimiters = 0
    semicolons = 0
    fieldIsEmpty = true
    hasContent = false
  }

  for (let index = 0; index < scanLength && records.length < 8; index += 1) {
    const ch = text[index]
    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"' && index + 1 < scanLength) {
          fieldIsEmpty = false
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        fieldIsEmpty = false
      }
      continue
    }
    if (ch === '"' && fieldIsEmpty) {
      inQuotes = true
      hasContent = true
      continue
    }
    if (ch === '\r' || ch === '\n') {
      pushRecord()
      if (ch === '\r' && text[index + 1] === '\n') {
        index += 1
      }
      continue
    }
    if (ch === delimiter) {
      delimiters += 1
      fieldIsEmpty = true
    } else {
      fieldIsEmpty = false
    }
    if (ch === ';') {
      semicolons += 1
    }
    hasContent ||= !isCsvSniffWhitespace(text.charCodeAt(index))
  }
  if (scanLength === text.length && records.length < 8 && !inQuotes) {
    pushRecord()
  }
  const first = records[0]
  return Boolean(
    first &&
    first.delimiters > 0 &&
    records.length > 1 &&
    records.every((record) => record.delimiters === first.delimiters) &&
    records.some((record) => record.semicolons !== first.semicolons)
  )
}

function findFirstNonEmptyCsvSniffLine(text: string): string {
  // Why: delimiter sniffing only needs one representative line; splitting a
  // pasted or dropped CSV can allocate one array entry per row before render.
  const scanLength = Math.min(text.length, CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)
  let lineStart = 0
  let lineHasContent = false

  for (let index = 0; index < scanLength; index += 1) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit === LINE_FEED_CODE_UNIT || codeUnit === CARRIAGE_RETURN_CODE_UNIT) {
      if (lineHasContent) {
        return text.slice(lineStart, index)
      }
      if (
        codeUnit === CARRIAGE_RETURN_CODE_UNIT &&
        index + 1 < scanLength &&
        text.charCodeAt(index + 1) === LINE_FEED_CODE_UNIT
      ) {
        index += 1
      }
      lineStart = index + 1
      lineHasContent = false
      continue
    }
    if (!lineHasContent && !isCsvSniffWhitespace(codeUnit)) {
      lineHasContent = true
    }
  }

  return lineHasContent ? text.slice(lineStart, scanLength) : ''
}

function isCsvSniffWhitespace(codeUnit: number): boolean {
  return (
    codeUnit === 0x09 ||
    codeUnit === 0x0b ||
    codeUnit === 0x0c ||
    codeUnit === 0x20 ||
    codeUnit === 0xa0
  )
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      count += 1
    }
  }
  return count
}
