import type { PreloadApi } from '../../../../preload/api-types'
import type { LinkPreviewResult } from '../../../../shared/link-preview'
import { callRuntimeResult } from './web-runtime-calls'

const UNAVAILABLE: LinkPreviewResult = { kind: 'unavailable' }

export function createWebLinkPreviewApi(): PreloadApi['linkPreview'] {
  return {
    get: (request) =>
      callRuntimeResult<LinkPreviewResult>('linkPreview.get', request).catch(() => UNAVAILABLE)
  }
}
