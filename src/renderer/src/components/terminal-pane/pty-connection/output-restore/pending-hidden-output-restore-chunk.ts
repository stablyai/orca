export type PendingHiddenOutputRestoreChunk = {
  data: string
  seq?: number
  rawLength?: number
  midEscape?: true | 'unknown'
}
