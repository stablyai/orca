import { parseCsv } from './csv-parse'
import type { CsvTextDocument } from './csv-text-document'

export function csvRecordTokens(document: CsvTextDocument, row: number): string[] {
  const source = document.source.slice(document.starts[row], document.contentEnds[row])
  const tokens: string[] = []
  parseCsv(source, document.delimiter, {
    stripBom: false,
    onField: (start, end) => tokens.push(source.slice(start, end))
  })
  return tokens
}
