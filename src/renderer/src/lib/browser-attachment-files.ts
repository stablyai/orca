import { createBrowserUuid } from '@/lib/browser-uuid'

// Browser Files lack paths; use claim tokens ending in the filename so path-based chips still display basename correctly.
const TOKEN_PREFIX = 'orca-browser-file:'

const heldFiles = new Map<string, File>()

export function holdBrowserAttachmentFiles(files: readonly File[]): string[] {
  return files.map((file) => {
    const token = `${TOKEN_PREFIX}${createBrowserUuid()}/${file.name}`
    heldFiles.set(token, file)
    return token
  })
}

export function takeBrowserAttachmentFile(token: string): File | null {
  const file = heldFiles.get(token) ?? null
  heldFiles.delete(token)
  return file
}

/** Releases whatever an attach left unclaimed (refused, abandoned, failed); other paths are ignored. */
export function releaseBrowserAttachmentFiles(paths: readonly string[]): void {
  for (const path of paths) {
    heldFiles.delete(path)
  }
}
