export type OrcaBackgroundLibraryImage = {
  fileName: string
  path: string
  size: number
}

export type OrcaBackgroundLibrary = {
  dir: string
  images: OrcaBackgroundLibraryImage[]
}

export type OrcaBackgroundImportResult = OrcaBackgroundLibrary & {
  added: string[]
  skipped: string[]
}

export type OrcaBackgroundImageLoadResult =
  | { ok: true; data: Uint8Array; mimeType: string }
  | {
      ok: false
      reason: 'invalid-name' | 'unsupported-type' | 'not-found' | 'too-large' | 'read-failed'
    }

export type OrcaBackgroundOpenLibraryResult = { ok: true } | { ok: false; reason: 'open-failed' }
