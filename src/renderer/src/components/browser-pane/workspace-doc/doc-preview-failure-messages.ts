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
  // Entry documents are served as text; unsupported formats fail only as subresources and belong in a notice.
  return translate(
    'auto.components.editor.HtmlDocPreview.documentUnreadablePanel',
    'Orca could not read this file from the workspace.'
  )
}

/** Keep rendered documents visible when only an asset fails; reserve the failure panel for the entry document. */
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

/** Use constant chrome text so document-controlled filenames and repeat counts cannot spam the refusal notice. */
export function docPreviewDownloadBlockedNotice(): string {
  return translate(
    'auto.components.editor.HtmlDocPreview.downloadBlockedNotice',
    'Downloads are disabled in document previews.'
  )
}

export function docPreviewNotices(
  isUnavailable: boolean,
  downloadBlocked: boolean,
  assetFailures: DocPreviewFileFailure[]
): string[] {
  // Nothing rendered on an unavailable preview, so a notice strip would be a footnote on a blank page.
  return isUnavailable
    ? []
    : [
        downloadBlocked ? docPreviewDownloadBlockedNotice() : null,
        docPreviewAssetNotice(assetFailures)
      ].filter((notice): notice is string => notice !== null)
}
