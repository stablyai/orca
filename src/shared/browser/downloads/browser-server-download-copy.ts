/** Save to this computer for a download a paired server saved, from its `downloadFinished` copy id. */
export type BrowserServerDownloadCopyArgs = {
  environmentId: string
  copyId: string
  // The server's name for it; only a cleaned name in Downloads is used.
  filename: string
  // The pairing that sent the copy id; a re-paired host must not answer for it.
  expectedEnvironmentPairingRevision?: number
}
