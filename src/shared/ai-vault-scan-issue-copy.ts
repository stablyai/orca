// One English table for Orca-authored Agent Session History scan copy: main builds the wire `message`, the renderer translates by code.
export const AI_VAULT_SCAN_ISSUE_COPY = {
  issuesOmitted: 'Additional scan issues were omitted.',
  sessionMetadataUnreadable: 'Session metadata could not be read this scan.',
  openCodeScannerUnavailable:
    'OpenCode history was skipped because its background scanner could not start; the app remains responsive.',
  openCodeScanIncomplete: 'OpenCode history scan did not complete: {{detail}}',
  openCodeWslReaderPreparing:
    'Preparing the WSL SQLite reader. Refresh Vault after setup finishes.',
  openCodeWslReaderNotPrepared: 'The WSL SQLite reader is not prepared. Refresh Vault to retry.',
  openCodeDatabaseBusy:
    '{{label}} is writing to {{name}} right now, so its history was skipped. It is read again on the next refresh.',
  openCodeDatabaseUnreadable: '{{label}} history in {{name}} could not be read: {{detail}}',
  openCodeWslDatabaseUnsupported:
    "{{label}} sessions inside WSL can't be searched from Windows yet.",
  openCodeWriteAheadLogUnreadable:
    '{{label}} history in {{name}} could not be read. Its write-ahead log cannot be opened read-only on this filesystem. Exit {{label}} cleanly to flush the log.',
  wslTranscriptFsSlow:
    'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.',
  wslTranscriptFsCapacity:
    'WSL transcript discovery is temporarily unavailable because too many filesystem requests are already waiting. Try again shortly or restart Orca if the issue continues.',
  wslTranscriptFsProcessFailed:
    'WSL transcript files are temporarily unavailable because the filesystem helper process failed ({{detail}}). Try again shortly or restart Orca if the issue continues.',
  wslDistroNotRunning:
    "WSL transcript files are unavailable because WSL distro '{{distro}}' is not running. Open a terminal in it to start it.",
  wslDistroUnverifiable:
    "WSL transcript files are unavailable because WSL didn't answer whether '{{distro}}' is running. Try again shortly.",
  wslSessionsFromLastScan: 'WSL could not be checked; its sessions are from the last scan.',
  scopePathsTruncated: 'Only the first {{limit}} project paths were scanned.',
  invalidResultsSkipped: 'Skipped {{count}} invalid Agent Session History result entries.',
  scanTimedOutOnSshHost:
    'Session scan timed out after {{seconds}}s on this SSH host. Refresh to try again.',
  scanTimedOut:
    'Session scan timed out after {{seconds}}s — the machine may be busy. Refresh to try again.',
  scannerPaused: 'Session scanning paused after repeated failures. Refresh to try again.',
  scannerBusy: 'Too many session scans in flight. Wait a moment, then refresh.',
  scannerMissing:
    'The session scanner is missing from this Orca install. Reinstalling Orca restores it.',
  scannerStopped: 'The session scanner stopped unexpectedly. Refresh to try again.'
} as const

/** English singular forms for the count-bearing codes above. */
export const AI_VAULT_SCAN_ISSUE_COPY_ONE = {
  invalidResultsSkipped: 'Skipped {{count}} invalid Agent Session History result entry.'
} as const

export type AiVaultScanIssueCode = keyof typeof AI_VAULT_SCAN_ISSUE_COPY

/** Wire fields: `message` stays English for older clients; `messageDetail` is verbatim diagnostic text. */
export type AiVaultScanIssueText = {
  message: string
  messageCode?: string
  messageParams?: Record<string, string | number>
  messageDetail?: string
}

type TemplateValues = {
  params?: Record<string, string | number>
  detail?: string
}

function englishTemplate(code: AiVaultScanIssueCode, count: unknown): string {
  return code === 'invalidResultsSkipped' && count === 1
    ? AI_VAULT_SCAN_ISSUE_COPY_ONE.invalidResultsSkipped
    : AI_VAULT_SCAN_ISSUE_COPY[code]
}

export function aiVaultScanIssueText(
  code: AiVaultScanIssueCode,
  values: TemplateValues = {}
): AiVaultScanIssueText {
  // One pass so a param containing "{{detail}}" stays verbatim.
  const message = englishTemplate(code, values.params?.count).replace(
    /\{\{(\w+)\}\}/g,
    (slot, name: string) =>
      name === 'detail' ? (values.detail ?? '') : String(values.params?.[name] ?? slot)
  )
  return {
    message,
    messageCode: code,
    ...(values.params ? { messageParams: values.params } : {}),
    ...(values.detail !== undefined ? { messageDetail: values.detail } : {})
  }
}
