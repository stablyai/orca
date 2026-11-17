import type { PreloadApi } from '../../../../../preload/api-types'
import type { LinkPreviewResult } from '../../../../../shared/browser/link-preview'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

const UNAVAILABLE: LinkPreviewResult = { kind: 'unavailable' }

export function createWebLinkPreviewApi(): PreloadApi['linkPreview'] {
  return {
    get: (request) =>
      callRuntimeResult<LinkPreviewResult>('linkPreview.get', request).catch(() => UNAVAILABLE)
  }
}
