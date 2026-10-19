import type { CsvIndex } from './csv-byte-index'

export type CsvWorkerCommand =
  | { kind: 'init'; delimiter: string }
  | { kind: 'feed'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'finish' }
  | { kind: 'parse'; bytes: Uint8Array<ArrayBuffer>; stripBom: boolean }

export type CsvWorkerValue =
  | { kind: 'ack' }
  | { kind: 'index'; index: CsvIndex }
  | { kind: 'rows'; rows: string[][] }
export type CsvWorkerRequest = { id: number; command: CsvWorkerCommand }
export type CsvWorkerResponse = { id: number } & (
  | { ok: true; value: CsvWorkerValue }
  | { ok: false; error: string }
)
