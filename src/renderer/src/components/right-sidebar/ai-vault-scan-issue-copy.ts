import { translate } from '@/i18n/i18n'
import {
  AI_VAULT_SCAN_ISSUE_COPY as EN,
  AI_VAULT_SCAN_ISSUE_COPY_ONE as EN_ONE,
  type AiVaultScanIssueCode,
  type AiVaultScanIssueText
} from '../../../../shared/ai-vault-scan-issue-copy'
import { classifyAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'

type Values = {
  distro: string | null
  label: string | null
  name: string | null
  count: number | null
  limit: number | null
  seconds: number | null
  detail: string | null
}

// null = required values missing; caller shows the host's English `message`.
const COPY: Record<AiVaultScanIssueCode, (values: Values) => string | null> = {
  issuesOmitted: () => translate('aiVault.scanIssues.issuesOmitted', EN.issuesOmitted),
  sessionMetadataUnreadable: () =>
    translate('aiVault.scanIssues.sessionMetadataUnreadable', EN.sessionMetadataUnreadable),
  openCodeScannerUnavailable: () =>
    translate('aiVault.scanIssues.openCodeScannerUnavailable', EN.openCodeScannerUnavailable),
  openCodeScanIncomplete: ({ detail }) =>
    detail === null
      ? null
      : translate('aiVault.scanIssues.openCodeScanIncomplete', EN.openCodeScanIncomplete, {
          detail
        }),
  openCodeWslReaderPreparing: () =>
    translate('aiVault.scanIssues.openCodeWslReaderPreparing', EN.openCodeWslReaderPreparing),
  openCodeWslReaderNotPrepared: () =>
    translate('aiVault.scanIssues.openCodeWslReaderNotPrepared', EN.openCodeWslReaderNotPrepared),
  openCodeDatabaseBusy: ({ label, name }) =>
    label === null || name === null
      ? null
      : translate('aiVault.scanIssues.openCodeDatabaseBusy', EN.openCodeDatabaseBusy, {
          label,
          name
        }),
  openCodeDatabaseUnreadable: ({ label, name, detail }) =>
    label === null || name === null || detail === null
      ? null
      : translate('aiVault.scanIssues.openCodeDatabaseUnreadable', EN.openCodeDatabaseUnreadable, {
          label,
          name,
          detail
        }),
  openCodeWslDatabaseUnsupported: ({ label }) =>
    label === null
      ? null
      : translate(
          'aiVault.scanIssues.openCodeWslDatabaseUnsupported',
          EN.openCodeWslDatabaseUnsupported,
          { label }
        ),
  openCodeWriteAheadLogUnreadable: ({ label, name }) =>
    label === null || name === null
      ? null
      : translate(
          'aiVault.scanIssues.openCodeWriteAheadLogUnreadable',
          EN.openCodeWriteAheadLogUnreadable,
          { label, name }
        ),
  wslTranscriptFsSlow: () =>
    translate('aiVault.scanIssues.wslTranscriptFsSlow', EN.wslTranscriptFsSlow),
  wslTranscriptFsCapacity: () =>
    translate('aiVault.scanIssues.wslTranscriptFsCapacity', EN.wslTranscriptFsCapacity),
  wslTranscriptFsProcessFailed: ({ detail }) =>
    detail === null
      ? null
      : translate(
          'aiVault.scanIssues.wslTranscriptFsProcessFailed',
          EN.wslTranscriptFsProcessFailed,
          { detail }
        ),
  wslDistroNotRunning: ({ distro }) =>
    distro === null
      ? null
      : translate('aiVault.scanIssues.wslDistroNotRunning', EN.wslDistroNotRunning, { distro }),
  wslDistroUnverifiable: ({ distro }) =>
    distro === null
      ? null
      : translate('aiVault.scanIssues.wslDistroUnverifiable', EN.wslDistroUnverifiable, {
          distro
        }),
  wslSessionsFromLastScan: () =>
    translate('aiVault.scanIssues.wslSessionsFromLastScan', EN.wslSessionsFromLastScan),
  scopePathsTruncated: ({ limit }) =>
    limit === null
      ? null
      : translate('aiVault.scanIssues.scopePathsTruncated', EN.scopePathsTruncated, { limit }),
  invalidResultsSkipped: ({ count }) =>
    count === null
      ? null
      : translate('aiVault.scanIssues.invalidResultsSkipped', EN.invalidResultsSkipped, {
          count,
          defaultValue_one: EN_ONE.invalidResultsSkipped
        }),
  scanTimedOutOnSshHost: ({ seconds }) =>
    seconds === null
      ? null
      : translate('aiVault.scanIssues.scanTimedOutOnSshHost', EN.scanTimedOutOnSshHost, {
          seconds
        }),
  scanTimedOut: ({ seconds }) =>
    seconds === null
      ? null
      : translate('aiVault.scanIssues.scanTimedOut', EN.scanTimedOut, {
          seconds
        }),
  scannerPaused: () => translate('aiVault.scanIssues.scannerPaused', EN.scannerPaused),
  scannerBusy: () => translate('aiVault.scanIssues.scannerBusy', EN.scannerBusy),
  scannerMissing: () => translate('aiVault.scanIssues.scannerMissing', EN.scannerMissing),
  scannerStopped: () => translate('aiVault.scanIssues.scannerStopped', EN.scannerStopped)
}

function isAiVaultScanIssueCode(code: unknown): code is AiVaultScanIssueCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

type IssueParams = NonNullable<AiVaultScanIssueText['messageParams']>

function stringParam(params: IssueParams, key: string): string | null {
  const value = Object.hasOwn(params, key) ? params[key] : undefined
  return typeof value === 'string' ? value : null
}

function numberParam(params: IssueParams, key: string): number | null {
  const value = Object.hasOwn(params, key) ? params[key] : undefined
  return typeof value === 'number' ? value : null
}

/** Scan issue text; uncoded (older host), unknown (newer host) or incomplete copy shows the English `message`. */
export function aiVaultScanIssueDisplayText(text: AiVaultScanIssueText): string {
  if (!isAiVaultScanIssueCode(text.messageCode)) {
    return text.message
  }
  // Unchecked wire data from a paired host: a non-object reads as no params.
  const params: IssueParams =
    typeof text.messageParams === 'object' && text.messageParams !== null ? text.messageParams : {}
  return (
    COPY[text.messageCode]({
      distro: stringParam(params, 'distro'),
      label: stringParam(params, 'label'),
      name: stringParam(params, 'name'),
      count: numberParam(params, 'count'),
      limit: numberParam(params, 'limit'),
      seconds: numberParam(params, 'seconds'),
      detail: typeof text.messageDetail === 'string' ? text.messageDetail : null
    }) ?? text.message
  )
}

/** Localized copy for a rejected scan; unrecognized errors keep their own text. */
export function aiVaultScanErrorText(raw: string): string {
  return aiVaultScanIssueDisplayText(classifyAiVaultScanError(raw))
}
