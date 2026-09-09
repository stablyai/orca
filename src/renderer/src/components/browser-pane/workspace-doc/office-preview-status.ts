/**
 * Every reader-facing sentence for an Office preview failure.
 *
 * Codes cross the process boundary; copy lives here. That split is what lets a host stay silent
 * about locale and lets one refusal read the same whether it came from this machine, an SSH relay
 * or a paired runtime.
 */
import {
  OFFICE_FORMAT_LABELS,
  type OfficeDocKind,
  type OfficeUnrenderableExtension
} from '../../../../../shared/office-file-extensions'
import type { OfficeErrorCode } from '../../../../../shared/office-preview-contracts'
import { translate } from '@/i18n/i18n'

/** The headline in the failure panel. Never names `officecli` unless the tool is the problem. */
export function officeFailureTitle(code: OfficeErrorCode): string {
  switch (code) {
    case 'OFFICECLI_NOT_FOUND':
      return translate(
        'auto.components.office.preview.missingBinaryTitle',
        'officecli is not installed'
      )
    case 'OFFICECLI_UNSUPPORTED_FORMAT':
      return translate(
        'auto.components.office.preview.unsupportedFormatTitle',
        "This format can't be previewed"
      )
    case 'OFFICE_RENDER_TOO_LARGE':
      return translate('auto.components.office.preview.tooLargeTitle', 'This document is too large')
    case 'OFFICE_HOST_UPDATE_REQUIRED':
      return translate(
        'auto.components.office.preview.updateRequiredTitle',
        'The paired machine needs updating'
      )
    case 'OFFICE_HOST_UNREACHABLE':
      return translate(
        'auto.components.office.preview.hostUnreachableTitle',
        "Orca couldn't reach the machine that owns this document"
      )
    case 'OFFICECLI_FILE_NOT_FOUND':
      return translate('auto.components.office.preview.fileMissingTitle', 'Document not found')
    case 'OFFICE_DOCUMENT_OUTSIDE_WORKSPACE':
      return translate(
        'auto.components.office.preview.outsideWorkspaceTitle',
        'This document is outside the workspace'
      )
    // Every remaining code shares one headline and explains itself on the detail line. Listed
    // rather than defaulted so a new code cannot inherit this wording without someone choosing it.
    case 'OFFICECLI_RENDER_FAILED':
    case 'OFFICECLI_ALREADY_WATCHED':
    case 'OFFICECLI_PORT_TIMEOUT':
    case 'OFFICECLI_WATCH_FAILED':
    case 'OFFICE_WATCH_NOT_RUNNING':
      return translate('auto.components.office.preview.renderFailedTitle', 'Preview unavailable')
  }
}

/**
 * The explanatory line. `hostLabel` is named wherever it changes what the reader should do: on a
 * remote workspace their own machine is the wrong place to look for a missing binary.
 */
export function officeFailureDetail(code: OfficeErrorCode, hostLabel: string | null): string {
  switch (code) {
    case 'OFFICECLI_NOT_FOUND':
      return hostLabel
        ? translate(
            'auto.components.office.preview.missingBinaryOnHost',
            'Office previews are rendered on {{host}}, which does not have officecli.',
            { host: hostLabel }
          )
        : translate(
            'auto.components.office.preview.missingBinaryHere',
            'Office previews need officecli on the machine that owns this document.'
          )
    case 'OFFICECLI_UNSUPPORTED_FORMAT':
      return translate(
        'auto.components.office.preview.unsupportedFormatDetail',
        'Open it in the app it belongs to.'
      )
    case 'OFFICE_RENDER_TOO_LARGE':
      return translate(
        'auto.components.office.preview.tooLargeDetail',
        'Rendering it produced more than Orca will send to a preview. Try the live preview, or open it in the system app.'
      )
    case 'OFFICE_HOST_UPDATE_REQUIRED':
      return translate(
        'auto.components.office.preview.updateRequiredDetail',
        'Office previews require a newer Orca on that machine. Update it and try again.'
      )
    case 'OFFICE_HOST_UNREACHABLE':
      // Deliberately says nothing about whether the render or a watch process is alive: loss of
      // contact is `unverifiable`. See docs/reference/ssh-execution-boundary.md.
      return translate(
        'auto.components.office.preview.hostUnreachableDetail',
        'Orca cannot tell whether the work is still running. Reconnect and try again.'
      )
    case 'OFFICECLI_ALREADY_WATCHED':
      return translate(
        'auto.components.office.preview.alreadyWatchedDetail',
        'Another process is already showing a live preview of this document.'
      )
    case 'OFFICECLI_PORT_TIMEOUT':
      return translate(
        'auto.components.office.preview.portTimeoutDetail',
        'The live preview server did not start in time. The snapshot is still available.'
      )
    case 'OFFICE_WATCH_NOT_RUNNING':
      return translate(
        'auto.components.office.preview.watchNotRunningDetail',
        'There is no live preview running for this document.'
      )
    case 'OFFICECLI_FILE_NOT_FOUND':
      return translate(
        'auto.components.office.preview.fileMissingDetail',
        'It may have been renamed or removed since the tab was opened.'
      )
    case 'OFFICE_DOCUMENT_OUTSIDE_WORKSPACE':
      // The host refuses a document that canonicalises outside the workspace it was named
      // against; say that plainly rather than blame the renderer or the tool.
      return translate(
        'auto.components.office.preview.outsideWorkspaceDetail',
        'Orca only previews documents that live inside the workspace they were opened from.'
      )
    case 'OFFICECLI_RENDER_FAILED':
    case 'OFFICECLI_WATCH_FAILED':
      return translate(
        'auto.components.office.preview.renderFailedDetail',
        'officecli could not render this document.'
      )
  }
}

/**
 * The unrenderable-format panel's sentence.
 *
 * It names the format and never mentions `officecli`: the tool was not the problem, and offering
 * an install would send the reader off to fix something that is already fine.
 */
export function officeUnrenderableMessage(extension: string): string {
  const label = OFFICE_FORMAT_LABELS[extension as OfficeUnrenderableExtension]
  return label
    ? translate(
        'auto.components.office.preview.unrenderableNamed',
        'Orca does not preview {{format}} files.',
        { format: label }
      )
    : translate(
        'auto.components.office.preview.unrenderableUnnamed',
        'Orca does not preview this file format.'
      )
}

/**
 * Marks header copy.
 *
 * The caller picks the plural key rather than leaving it to i18next, matching
 * `connectedHostCountLabel`: `translate(key, fallback)` resolves the inline fallback for `en`, so
 * a single key with `{{count}}` would render "1 marks" however the catalog is written.
 */
export function officeMarksTitle(count: number): string {
  return count === 1
    ? translate(
        'auto.components.office.preview.marksTitle_one',
        '{{count}} mark proposed for review',
        {
          count
        }
      )
    : translate(
        'auto.components.office.preview.marksTitle_other',
        '{{count}} marks proposed for review',
        { count }
      )
}

export function officeDocKindLabel(kind: OfficeDocKind): string {
  switch (kind) {
    case 'word':
      return translate('auto.components.office.preview.kindWord', 'Document')
    case 'excel':
      return translate('auto.components.office.preview.kindExcel', 'Spreadsheet')
    case 'ppt':
      return translate('auto.components.office.preview.kindPpt', 'Presentation')
  }
}

/** Why the selection control is unavailable, stated rather than discovered at click time. */
export function officeSelectionUnavailableReason(kind: OfficeDocKind): string | null {
  return kind === 'excel'
    ? translate(
        'auto.components.office.preview.selectionUnavailableExcel',
        'Spreadsheets do not expose addressable cells, so selection is unavailable here.'
      )
    : null
}
