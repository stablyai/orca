import type {
  NativePowerPointPreviewRequest,
  NativePowerPointPreviewResult
} from '../../../../shared/powerpoint-preview'
import { decodeBase64Document } from './office-document-parse'

type NativePowerPointRenderer = (
  request: NativePowerPointPreviewRequest
) => Promise<NativePowerPointPreviewResult>

export async function resolvePresentationPreviewBuffer(
  contentBase64: string,
  originalBuffer: ArrayBuffer,
  requestToken: string,
  renderNative: NativePowerPointRenderer | undefined = window.api.powerpointPreview?.render
): Promise<ArrayBuffer> {
  if (!renderNative) {
    return originalBuffer
  }
  try {
    const result = await renderNative({ contentBase64, requestToken })
    return result.status === 'rendered'
      ? decodeBase64Document(result.contentBase64)
      : originalBuffer
  } catch {
    // Why: native rendering is an optional Windows capability; browser rendering
    // must remain available when PowerPoint is missing or IPC is unavailable.
    return originalBuffer
  }
}
