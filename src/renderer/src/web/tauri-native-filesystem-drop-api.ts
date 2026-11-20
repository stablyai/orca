import type { FilesystemApi } from '../../../preload/api/filesystem/filesystem-api'
import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../../shared/file-import/native-file-drop'
import type { PreparedDroppedPaths } from '../../../shared/file-import/native-file-drop-preparation'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

type FilesystemDropApi = Pick<FilesystemApi['fs'], 'getPathForFile' | 'prepareDroppedPaths'>

export function createTauriNativeFilesystemDropApi(): Partial<FilesystemDropApi> {
  if (!isTauriNativeHost()) {
    // Keep the web implementation's explicit unsupported error. Returning a
    // native stub here would shadow it even when the bridge is not present.
    return {}
  }
  return {
    getPathForFile: (file: File) => {
      if ('path' in file && typeof file.path === 'string') {
        return file.path
      }
      return ''
    },
    prepareDroppedPaths: async ({ paths }): Promise<PreparedDroppedPaths> => {
      const validation = validateNativeFileDropPaths(paths)
      if (validation.status === 'rejected') {
        return {
          paths: [],
          failures: [createRejectedNativeFileDropPayload(validation)]
        }
      }
      try {
        const accepted = await invokeNative<string[]>('poc_validate_dropped_paths', { paths })
        return { paths: accepted, failures: [] }
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        if (reason === 'too-many-paths' || reason === 'paths-too-large') {
          return {
            paths: [],
            failures: [
              {
                target: 'rejected',
                reason,
                pathCount: paths.length,
                byteLength: validation.byteLength
              }
            ]
          }
        }
        return {
          paths: [],
          failures: [
            {
              target: 'rejected',
              reason: 'temp-copy-failed',
              commonReason: 'copy-failed',
              pathCount: paths.length,
              byteLength: validation.byteLength
            }
          ]
        }
      }
    }
  }
}
