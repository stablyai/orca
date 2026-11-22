/** OS-level memory for the current renderer, in Electron-reported kilobytes. */
export type RendererProcessMemory = {
  /** Not shared with any other process — the number Windows Task Manager shows. */
  privateKB: number
  /** Absent on platforms where Chromium does not report a resident set. */
  residentKB?: number
}
