import type { PreloadApi } from '../../../../preload/api-types'
import { holdBrowserAttachmentFiles } from '@/lib/browser-attachment-files'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'

async function pathExistsOnRuntime(path: string): Promise<boolean> {
  try {
    await resolveRuntimeFilePath(path)
    return true
  } catch {
    return false
  }
}

/** The browser's file picker; resolves empty when the user cancels it. */
function pickBrowserFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

export function createShellApi(): NonNullable<Partial<PreloadApi>['shell']> {
  const openResult = { ok: true } as const
  return {
    openPath: (path) =>
      Promise.resolve(window.open(path, '_blank', 'noopener,noreferrer') as never),
    openInFileManager: () => Promise.resolve(openResult),
    openInExternalEditor: () => Promise.resolve(openResult),
    openUrl: (url) => Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer') as never),
    openFilePath: () => Promise.resolve(false),
    openFileUri: (uri) =>
      Promise.resolve(window.open(uri, '_blank', 'noopener,noreferrer') as never),
    pathExists: async (path) => pathExistsOnRuntime(path),
    // Without this the fallback proxy answers `undefined` and the caller's batch rejects.
    pathsExist: (paths) => Promise.all(paths.map((path) => pathExistsOnRuntime(path))),
    pickAttachment: () => Promise.resolve(null),
    // Tokens for the picked files, which the chat upload reads; a browser has no file paths.
    pickAttachments: async () => holdBrowserAttachmentFiles(await pickBrowserFiles()),
    pickImage: () => Promise.resolve(null),
    pickRepoIconImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}
