import type { PreloadApi } from '../../../../preload/api-types'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import {
  readClipboardImagePngBase64,
  saveClipboardImageAsTempFileInRuntime
} from './web-clipboard-api'

export function createWebClipboardPreviewApi(): Pick<
  PreloadApi['ui'],
  'saveClipboardImagePreview' | 'settleClipboardImagePreview'
> {
  return {
    saveClipboardImagePreview: async (args) => {
      const environmentId = args?.runtimeEnvironmentId ?? requireActiveEnvironmentOrNull()?.id
      if (!environmentId) {
        return null
      }
      const support = await callEnvironmentEnvelope(
        environmentId,
        'clipboard.imageLeaseAvailable',
        {}
      )
      if (!support.ok) {
        throw new Error('Update the remote Orca server to use image preview')
      }
      const contentBase64 = await readClipboardImagePngBase64()
      if (!contentBase64) {
        return null
      }
      const path = await saveClipboardImageAsTempFileInRuntime(contentBase64, {
        ...args,
        runtimeEnvironmentId: environmentId,
        discardable: true
      })
      return {
        path,
        dataUrl: `data:image/png;base64,${contentBase64}`,
        runtimeEnvironmentId: environmentId
      }
    },
    settleClipboardImagePreview: async (args) => {
      if (!args.runtimeEnvironmentId) {
        throw new Error('Image preview runtime owner is missing')
      }
      const response = await callEnvironmentEnvelope(
        args.runtimeEnvironmentId,
        'clipboard.imageLease',
        {
          path: args.path,
          connectionId: args.connectionId,
          retain: args.retain,
          release: args.release
        }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    }
  }
}
