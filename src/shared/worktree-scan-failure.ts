export type WorktreeScanFailureKind = 'xcode-license' | 'xcode-tools-missing' | 'unknown'

export const XCODE_LICENSE_FIX_COMMAND = 'sudo xcodebuild -license accept'
export const XCODE_TOOLS_FIX_COMMAND = 'xcode-select --install'

// Why: macOS major upgrades invalidate Xcode license acceptance, so every repo scan fails with the same sudo stderr.
export function classifyWorktreeScanFailure(reason: unknown): WorktreeScanFailureKind {
  const text = reason instanceof Error ? reason.message : String(reason ?? '')
  const lower = text.toLowerCase()
  if (lower.includes('xcode') && lower.includes('license')) {
    return 'xcode-license'
  }
  // Why: "requires Xcode" means the active developer directory is a Command Line Tools instance
  // and the tool needs a full Xcode selected or installed, which `xcode-select --install` never
  // provides. Leave it unclassified rather than hand out a fix that cannot work.
  if (lower.includes('requires xcode')) {
    return 'unknown'
  }
  if (
    lower.includes('invalid active developer path') ||
    lower.includes('no developer tools were found') ||
    (lower.includes('xcrun') &&
      (lower.includes('unable to find') ||
        lower.includes('not found') ||
        lower.includes('invalid'))) ||
    (lower.includes('command line tools') &&
      (lower.includes('missing') || lower.includes('not installed')))
  ) {
    return 'xcode-tools-missing'
  }
  return 'unknown'
}

export function getWorktreeScanFailureFixCommand(kind: WorktreeScanFailureKind): string | null {
  if (kind === 'xcode-license') {
    return XCODE_LICENSE_FIX_COMMAND
  }
  if (kind === 'xcode-tools-missing') {
    return XCODE_TOOLS_FIX_COMMAND
  }
  return null
}
