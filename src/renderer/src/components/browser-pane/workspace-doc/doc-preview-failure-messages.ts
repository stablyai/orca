import type {
  DocPreviewFileFailure,
  DocPreviewFileFailureReason
} from '../../../../../shared/doc-preview-scheme'
import { translate } from '@/i18n/i18n'

export function docPreviewFailureDetail(reason: DocPreviewFileFailureReason | null): string {
  if (reason === 'too-large') {
    return translate(
      'auto.components.editor.HtmlDocPreview.documentTooLargePanel',
      'This document is too large to preview. Open it in the editor instead.'
    )
  }
  // Why no 'unsupported-asset' sentence here: the entry document is served as text by every owner
  // — only a subresource can be refused for its format, and that failure is a notice, not a panel.
  return translate(
    'auto.components.editor.HtmlDocPreview.documentUnreadablePanel',
    'Orca could not read this file from the workspace.'
  )
}

/**
 * Why a notice and not the failure panel: only the entry document's failure leaves the reader with
 * nothing to look at. A stylesheet, image or font the workspace would not send is a document that
 * rendered — degraded, and the reader deserves to know which piece is missing, but rendered.
 */
export function docPreviewAssetNotice(failures: DocPreviewFileFailure[]): string | null {
  const [first] = failures
  if (!first) {
    return null
  }
  if (failures.length > 1) {
    return translate(
      'auto.components.editor.HtmlDocPreview.multipleAssetsFailedNotice',
      '{{count}} files in this document could not be loaded.',
      { count: failures.length }
    )
  }
  if (first.reason === 'too-large') {
    return translate(
      'auto.components.editor.HtmlDocPreview.assetTooLargeNotice',
      '{{path}} is too large to load in this preview.',
      { path: first.relativePath }
    )
  }
  if (first.reason === 'unsupported-asset') {
    return translate(
      'auto.components.editor.HtmlDocPreview.assetUnsupportedNotice',
      'This workspace cannot send {{path}} to a preview.',
      { path: first.relativePath }
    )
  }
  return translate(
    'auto.components.editor.HtmlDocPreview.assetUnreadableNotice',
    'Orca could not read {{path}} from the workspace.',
    { path: first.relativePath }
  )
}

/**
 * Why the sentence names no file and does not count attempts: the document chooses both, and this
 * row is Orca's chrome. Constant text is also what makes repeated attempts unspammable — the
 * hundredth refusal renders exactly what the first one did.
 */
export function docPreviewDownloadBlockedNotice(): string {
  return translate(
    'auto.components.editor.HtmlDocPreview.downloadBlockedNotice',
    'Downloads are disabled in document previews.'
  )
}
