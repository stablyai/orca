export type LocalRecovery = {
  text: string
  remoteText: string
}

export type DraftRecoveryResolution = {
  text: string
  baseToken: string
  dirty: boolean
  conflict: boolean
}

const RECOVERED_DRAFT_PREFIX = 'orca:terminal-draft-recovery:v1:'

/** Pure so the "restore my local copy" rule is testable without a live runtime. */
export function resolveDraftRecovery(input: {
  local: LocalRecovery | undefined
  remoteText: string
  remoteToken: string
}): DraftRecoveryResolution {
  const { local, remoteText, remoteToken } = input
  if (!local) {
    return { text: remoteText, baseToken: remoteToken, dirty: false, conflict: false }
  }
  // Why: a stale record can outlive the save that made its text current; there is nothing to recover.
  if (local.text === remoteText) {
    return { text: remoteText, baseToken: remoteToken, dirty: false, conflict: false }
  }
  // Why: the terminal changed after this copy was parked, so neither version is authoritative.
  if (local.remoteText !== remoteText) {
    return { text: local.text, baseToken: remoteToken, dirty: true, conflict: true }
  }
  return {
    text: local.text,
    baseToken: remoteToken,
    dirty: local.text !== remoteText,
    conflict: false
  }
}

export function readRecoveredDraft(recoveryKey: string): LocalRecovery | undefined {
  try {
    const raw = window.localStorage.getItem(RECOVERED_DRAFT_PREFIX + recoveryKey)
    if (!raw) {
      return undefined
    }
    const parsed: unknown = JSON.parse(raw)
    return parsed &&
      typeof parsed === 'object' &&
      'text' in parsed &&
      typeof parsed.text === 'string' &&
      'remoteText' in parsed &&
      typeof parsed.remoteText === 'string'
      ? { text: parsed.text, remoteText: parsed.remoteText }
      : undefined
  } catch {
    return undefined
  }
}

export function writeRecoveredDraft(recoveryKey: string, recovery: LocalRecovery): void {
  try {
    window.localStorage.setItem(RECOVERED_DRAFT_PREFIX + recoveryKey, JSON.stringify(recovery))
  } catch {}
}

export function clearRecoveredDraft(recoveryKey: string): void {
  try {
    window.localStorage.removeItem(RECOVERED_DRAFT_PREFIX + recoveryKey)
  } catch {}
}
