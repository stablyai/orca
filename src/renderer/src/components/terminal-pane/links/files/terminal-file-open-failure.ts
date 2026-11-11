export type FileOpenFailure = {
  /** `missing` is a verified absence; `unverifiable` means the host could not answer (dropped SSH, timeout, denied path); `unavailable` means the path exists but this computer has no route that can open it. */
  verdict: 'missing' | 'unverifiable' | 'unavailable'
  error?: unknown
}
