import type { PreloadApi } from '../../../../preload/api-types'
import { classifyExternalAppUrl } from '../../../../shared/external-app-url'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'

export function createShellApi(): NonNullable<Partial<PreloadApi>['shell']> {
  const openResult = { ok: true } as const
  return {
    openPath: (path) =>
      Promise.resolve(window.open(path, '_blank', 'noopener,noreferrer') as never),
    openInFileManager: () => Promise.resolve(openResult),
    openInExternalEditor: () => Promise.resolve(openResult),
    openUrl: async (url) => {
      // Why: desktop has a Cancel-default confirmation for custom schemes; web
      // has no controlled approval surface, so only HTTP(S) may leave the app.
      const classified = classifyExternalAppUrl(url)
      if (!classified.ok || classified.kind !== 'http') {
        return
      }
      window.open(classified.url, '_blank', 'noopener,noreferrer')
    },
    openFilePath: () => Promise.resolve(false),
    openFileUri: (uri) =>
      Promise.resolve(window.open(uri, '_blank', 'noopener,noreferrer') as never),
    pathExists: async (path) => {
      try {
        await resolveRuntimeFilePath(path)
        return true
      } catch {
        return false
      }
    },
    pickAttachment: () => Promise.resolve(null),
    pickImage: () => Promise.resolve(null),
    pickRepoIconImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}
