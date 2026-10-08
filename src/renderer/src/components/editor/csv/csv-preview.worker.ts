import { CsvByteIndex, CSV_MAX_COLUMNS, CSV_RECORD_BYTES, CSV_PAGE_CELLS } from './csv-byte-index'
import { parseCsv } from './csv-parse'
import type {
  CsvWorkerRequest,
  CsvWorkerResponse,
  CsvWorkerValue
} from './csv-preview-worker-protocol'

let index: CsvByteIndex | null = null
let delimiter = ','
self.onmessage = (event: MessageEvent<CsvWorkerRequest>): void => {
  const { id, command } = event.data
  try {
    let value: CsvWorkerValue = { kind: 'ack' }
    if (command.kind === 'init') {
      delimiter = command.delimiter
      index = new CsvByteIndex(delimiter.charCodeAt(0))
    } else if (command.kind === 'feed') {
      if (!index) {
        throw new Error('CSV index is not initialized')
      }
      index.feed(command.bytes)
    } else if (command.kind === 'finish') {
      if (!index) {
        throw new Error('CSV index is not initialized')
      }
      value = { kind: 'index', index: index.finish() }
      index = null
    } else {
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        command.bytes
      )
      value = {
        kind: 'rows',
        rows: parseCsv(source, delimiter, {
          maxCells: CSV_PAGE_CELLS,
          maxColumns: CSV_MAX_COLUMNS,
          maxRecordLength: CSV_RECORD_BYTES,
          stripBom: command.stripBom
        }).rows
      }
    }
    const response: CsvWorkerResponse = { id, ok: true, value }
    self.postMessage(response)
  } catch (error) {
    const response: CsvWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
