/**
 * Materialize a collab selection atlas (data URI) to a host temp PNG path
 * that terminal agents can open — same handle as clipboard screenshot paste.
 *
 * Uses existing clipboard IPC (write image → save temp) rather than a new
 * main-process channel. Briefly overwrites the OS image clipboard.
 */

export type MaterializeAtlasResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: string }

function parseDataUriPng(dataUri: string): string | null {
  const trimmed = dataUri.trim()
  // data:image/png;base64,...  (also allow image/*)
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(trimmed)
  if (!match) {
    return null
  }
  return match[1].replace(/\s+/g, '')
}

/**
 * Write atlas data URI to a temp PNG via Orca clipboard helpers.
 * Returns absolute path suitable for pasting into a TUI agent.
 */
export async function materializeCollabAtlasToTempFile(
  atlasDataUri: string | null | undefined,
  deps?: {
    writeClipboardImage?: (dataUrl: string) => Promise<void>
    saveClipboardImageAsTempFile?: () => Promise<string | null>
  }
): Promise<MaterializeAtlasResult> {
  if (!atlasDataUri?.trim()) {
    return { ok: false, reason: 'no-atlas' }
  }
  if (!parseDataUriPng(atlasDataUri)) {
    return { ok: false, reason: 'invalid-data-uri' }
  }

  const writeClipboardImage =
    deps?.writeClipboardImage ??
    ((dataUrl: string) => {
      const api = window.api?.ui?.writeClipboardImage
      if (!api) {
        return Promise.reject(new Error('writeClipboardImage unavailable'))
      }
      return api(dataUrl)
    })

  const saveClipboardImageAsTempFile =
    deps?.saveClipboardImageAsTempFile ??
    (() => {
      const api = window.api?.ui?.saveClipboardImageAsTempFile
      if (!api) {
        return Promise.reject(new Error('saveClipboardImageAsTempFile unavailable'))
      }
      return api()
    })

  try {
    await writeClipboardImage(atlasDataUri)
    const filePath = await saveClipboardImageAsTempFile()
    if (!filePath?.trim()) {
      return { ok: false, reason: 'save-returned-empty' }
    }
    return { ok: true, filePath: filePath.trim() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `materialize-failed: ${msg}` }
  }
}
