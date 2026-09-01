/**
 * Maps the session scanner's internal supervision errors onto copy a user can
 * act on. Applied at both surfaces the panel paints: the local leg's scan-issue
 * row and the thrown-rejection banner. Anything unrecognized passes through, so
 * scanner-authored messages (host name, remote path, cap) keep their own wording.
 */
const RETRY = 'Refresh to try again.'

/** Electron wraps every rejected `ipcMain.handle` before the renderer sees it. */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/
/** Relay-hosted scanner errors carry a transport-only `Relay ` prefix. */
const RELAY_PREFIX = /^Relay (?=AI Vault )/
/** Both the fork-based service and the legacy worker thread emit this family. */
const SCANNER = String.raw`AI Vault (?:service|scanner worker)`

function toSeconds(ms: string): number {
  return Math.max(1, Math.round(Number(ms) / 1000))
}

function humanize(text: string): string | null {
  const sshTimeout = /^Agent Session History scan timed out after (\d+)ms on this SSH host\.$/.exec(
    text
  )
  if (sshTimeout) {
    return `Session scan timed out after ${toSeconds(sshTimeout[1]!)}s on this SSH host. ${RETRY}`
  }
  const timeout = new RegExp(String.raw`^${SCANNER} timed out after (\d+)ms\.$`).exec(text)
  if (timeout) {
    return `Session scan timed out after ${toSeconds(timeout[1]!)}s — the machine may be busy. ${RETRY}`
  }
  if (text === 'AI Vault service restart circuit is open.') {
    return `Session scanning paused after repeated failures. ${RETRY}`
  }
  if (new RegExp(String.raw`^${SCANNER} (?:client )?queue is full\.$`).test(text)) {
    return 'Too many session scans in flight. Wait a moment, then refresh.'
  }
  if (new RegExp(String.raw`^${SCANNER} entry not found: `).test(text)) {
    return 'The session scanner is missing from this Orca install. Reinstalling Orca restores it.'
  }
  if (new RegExp(String.raw`^${SCANNER}\b`).test(text)) {
    return `The session scanner stopped unexpectedly. ${RETRY}`
  }
  return null
}

/** Returns user-facing copy, or the original text when it is already meaningful. */
export function describeAiVaultScanError(raw: string): string {
  const text = raw.replace(IPC_INVOKE_PREFIX, '').replace(RELAY_PREFIX, '')
  return humanize(text) ?? text
}
