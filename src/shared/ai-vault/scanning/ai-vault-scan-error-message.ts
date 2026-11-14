import { aiVaultScanIssueText, type AiVaultScanIssueText } from './ai-vault-scan-issue-copy'

// Map supervision errors at scan-issue rows and rejection banners. Pass unknown scanner-authored messages through to retain host/path/cap details.

/** Electron wraps every rejected `ipcMain.handle` before the renderer sees it. */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/
/** Relay-hosted scanner errors carry a transport-only `Relay ` prefix. */
const RELAY_PREFIX = /^Relay (?=AI Vault )/
/** Both the fork-based service and the legacy worker thread emit this family. */
const SCANNER = String.raw`AI Vault (?:service|scanner worker)`

function toSeconds(ms: string): number {
  return Math.max(1, Math.round(Number(ms) / 1000))
}

function classify(text: string): AiVaultScanIssueText | null {
  const sshTimeout = /^Agent Session History scan timed out after (\d+)ms on this SSH host\.$/.exec(
    text
  )
  if (sshTimeout) {
    return aiVaultScanIssueText('scanTimedOutOnSshHost', {
      params: { seconds: toSeconds(sshTimeout[1]!) }
    })
  }
  const timeout = new RegExp(String.raw`^${SCANNER} timed out after (\d+)ms\.$`).exec(text)
  if (timeout) {
    return aiVaultScanIssueText('scanTimedOut', {
      params: { seconds: toSeconds(timeout[1]!) }
    })
  }
  if (text === 'AI Vault service restart circuit is open.') {
    return aiVaultScanIssueText('scannerPaused')
  }
  if (new RegExp(String.raw`^${SCANNER} (?:client )?queue is full\.$`).test(text)) {
    return aiVaultScanIssueText('scannerBusy')
  }
  if (new RegExp(String.raw`^${SCANNER} entry not found: `).test(text)) {
    return aiVaultScanIssueText('scannerMissing')
  }
  if (new RegExp(String.raw`^${SCANNER}\b`).test(text)) {
    return aiVaultScanIssueText('scannerStopped')
  }
  return null
}

/** User-facing copy with its code when the error is a known supervision fault; otherwise the original text. */
export function classifyAiVaultScanError(raw: string): AiVaultScanIssueText {
  const text = raw.replace(IPC_INVOKE_PREFIX, '').replace(RELAY_PREFIX, '')
  return classify(text) ?? { message: text }
}

/** Returns user-facing copy, or the original text when it is already meaningful. */
export function describeAiVaultScanError(raw: string): string {
  return classifyAiVaultScanError(raw).message
}
