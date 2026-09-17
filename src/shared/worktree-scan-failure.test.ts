import { describe, expect, it } from 'vitest'
import {
  XCODE_LICENSE_FIX_COMMAND,
  XCODE_TOOLS_FIX_COMMAND,
  classifyWorktreeScanFailure,
  getWorktreeScanFailureFixCommand
} from './worktree-scan-failure'

describe('classifyWorktreeScanFailure', () => {
  it('matches Xcode license stderr case-insensitively', () => {
    expect(
      classifyWorktreeScanFailure(
        'Agreeing to the Xcode/iOS license requires admin privileges, please run "sudo xcodebuild -license" and retry.'
      )
    ).toBe('xcode-license')
    expect(classifyWorktreeScanFailure('SUDO XCODEBUILD -LICENSE ACCEPT needed')).toBe(
      'xcode-license'
    )
    expect(
      classifyWorktreeScanFailure(new Error('You have not agreed to the Xcode license agreements'))
    ).toBe('xcode-license')
  })

  it('matches missing command line tools with the install hint', () => {
    expect(
      classifyWorktreeScanFailure(
        'xcrun: error: invalid active developer path (/Library/Developer)'
      )
    ).toBe('xcode-tools-missing')
    expect(
      classifyWorktreeScanFailure(
        "xcode-select: error: no developer tools were found at '/Applications/Xcode.app'"
      )
    ).toBe('xcode-tools-missing')
  })

  // Why: this one needs a full Xcode selected or installed; `xcode-select --install` installs the
  // Command Line Tools and leaves the scan failing, so the raw reason is the honest answer.
  it('refuses to call the full-Xcode requirement a missing-tools failure', () => {
    expect(
      classifyWorktreeScanFailure(
        "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance"
      )
    ).toBe('unknown')
  })

  it('falls back to unknown for unrelated failures', () => {
    expect(classifyWorktreeScanFailure('wsl.exe host failure: WSL_E_DISTRO_NOT_FOUND')).toBe(
      'unknown'
    )
    expect(classifyWorktreeScanFailure('')).toBe('unknown')
  })

  it('returns the matching fix command', () => {
    expect(getWorktreeScanFailureFixCommand('xcode-license')).toBe(XCODE_LICENSE_FIX_COMMAND)
    expect(getWorktreeScanFailureFixCommand('xcode-tools-missing')).toBe(XCODE_TOOLS_FIX_COMMAND)
    expect(getWorktreeScanFailureFixCommand('unknown')).toBeNull()
  })
})
