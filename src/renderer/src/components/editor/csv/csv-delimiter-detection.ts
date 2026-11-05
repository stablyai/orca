export const CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS = 64 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13
const CANDIDATE_DELIMITERS = ',;\t|'

export function detectCsvDelimiter(filePath: string, content: string): string {
  if (filePath.toLowerCase().endsWith('.tsv')) {
    return '\t'
  }
  // Strip the UTF-8 BOM before sniffing so it cannot affect first-cell classification.
  let text = content
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  // Skip blank leading lines, whose zero-delimiter tie would incorrectly classify TSV as comma-separated.
  const firstLine = findFirstNonEmptyCsvSniffLine(text)
  const tabs = countDelimiterOutsideQuotes(firstLine, '\t')
  const semicolons = countDelimiterOutsideQuotes(firstLine, ';')
  const commas = countDelimiterOutsideQuotes(firstLine, ',')
  const pipes = countDelimiterOutsideQuotes(firstLine, '|')
  // Keep the existing comma/tab choice unless semicolon, then pipe, strictly wins.
  let delimiter = tabs > commas ? '\t' : ','
  if (
    semicolons > Math.max(commas, tabs) &&
    !hasConsistentExistingCsvColumns(text, delimiter, ';')
  ) {
    delimiter = ';'
  }
  if (
    pipes > Math.max(commas, tabs, semicolons) &&
    !hasConsistentExistingCsvColumns(text, delimiter, '|')
  ) {
    delimiter = '|'
  }
  return delimiter
}

// Header punctuation should not replace an otherwise consistent table.
function hasConsistentExistingCsvColumns(
  text: string,
  delimiter: string,
  challenger: string
): boolean {
  const scanLength = Math.min(text.length, CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)
  const records: { delimiters: number; challengers: number }[] = []
  let delimiters = 0
  let challengers = 0
  let inQuotes = false
  let fieldIsEmpty = true
  let hasContent = false
  const pushRecord = (): void => {
    if (hasContent) {
      records.push({ delimiters, challengers })
    }
    delimiters = 0
    challengers = 0
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
    if (ch === challenger) {
      challengers += 1
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
    records.some((record) => record.challengers !== first.challengers)
  )
}

function findFirstNonEmptyCsvSniffLine(text: string): string {
  // Scan a representative line without allocating an array entry per pasted/dropped row.
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
    // Like the parser, only a field-start quote opens one; any candidate may end the prior field.
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1
      } else if (inQuotes) {
        inQuotes = false
      } else if (i === 0 || CANDIDATE_DELIMITERS.includes(line[i - 1])) {
        inQuotes = true
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      count += 1
    }
  }
  return count
}
