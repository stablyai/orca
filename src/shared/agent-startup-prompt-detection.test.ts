import { describe, expect, it } from 'vitest'
import {
  detectTerminalWaitBlockedReason,
  findActionableTerminalWaitBlockedSignal,
  isKnownReadyPromptPreview
} from './agent-startup-prompt-detection'

// Fixtures ported verbatim from src/main/runtime/orca-runtime.test.ts (the detector's
// original home) so this module and the OrcaRuntimeService integration tests exercise the
// exact same banner text — see the "Step 1" extraction in
// docs/plans/... (agent-startup-prompt-detection). Real captures from the Codex update flow
// (from the user-reported PowerShell/Windows update session) are marked below.

const CODEX_READY_HEADER = [
  ' >_ OpenAI Codex (v0.132.0)\n',
  ' model:       gpt-5.5 high   /model to change\n',
  ' directory:   ~/orca/workspaces/orca/cli-debug\n'
].join('')

function cursorReadyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    'Tip: Use /plan to plan execution and reach the right outcome faster.',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

function cursorBusyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    '⠰⠳ Thinking  28.61k tokens',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

describe('detectTerminalWaitBlockedReason', () => {
  it('detects a Codex update prompt', () => {
    const preview = [
      'Update available! 0.131.0 -> 0.132.0\n',
      '1. Update now\n',
      '2. Skip\n',
      'Press enter to continue\n'
    ].join('')
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-update-prompt')
  })

  it('detects a Codex workspace trust prompt', () => {
    const preview = 'Do you trust this workspace directory?\n1. Yes\n2. No\n'
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-trust-workspace')
  })

  it('detects a Codex cwd selection prompt', () => {
    const preview = [
      'Choose working directory to resume this session\n',
      '  Session = latest cwd recorded in the resumed session\n',
      '  Current = your current working directory\n',
      '  Press enter to continue\n'
    ].join('')
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-cwd-prompt')
  })

  it('detects a Codex model migration prompt', () => {
    const preview = [
      'Codex just got an upgrade. Introducing gpt-5.1-codex-max.\n',
      'We recommend switching from gpt-5-codex to gpt-5.1-codex-max.\n',
      'Press enter to continue\n'
    ].join('')
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-model-migration-prompt')
  })

  it('detects a Codex hooks-review prompt', () => {
    const preview = [
      'Hooks need review\n',
      '2 hooks are new or changed.\n',
      '1. Review hooks\n',
      '2. Trust all and continue\n',
      'Press enter to confirm or esc to go back\n'
    ].join('')
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-hooks-review-prompt')
  })

  it('returns null for a ready Codex header with no blocked signal', () => {
    expect(detectTerminalWaitBlockedReason(CODEX_READY_HEADER)).toBeNull()
  })

  // Real capture: the update flow reported over screenshot. Codex's update check runs
  // before it ever draws the "OpenAI Codex / Model: / Directory:" ready header, so the
  // header never appears in the same viewport as the dialog — findDismissedStartupModalIndex
  // must not suppress this signal. See the plan's Step 0 analysis.
  it('detects the real update-prompt banner with no ready header present (#Codex-restart-capture)', () => {
    const preview = [
      'Update available! 0.145.0 -> 0.146.0\n',
      '1. Update now\n',
      '2. Skip\n',
      'Press enter to continue\n'
    ].join('')
    expect(detectTerminalWaitBlockedReason(preview)).toBe('codex-update-prompt')
    expect(isKnownReadyPromptPreview(preview)).toBe(false)
  })
})

describe('findActionableTerminalWaitBlockedSignal — dismissed-modal downgrade', () => {
  it('picks the later blocked reason when a ready header sits between two prompts', () => {
    const preview = [
      'Update available! 0.131.0 -> 0.132.0\n',
      'Press enter to continue\n',
      CODEX_READY_HEADER,
      'Hooks need review\n',
      'Press enter to confirm\n'
    ].join('')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())?.reason).toBe(
      'codex-hooks-review-prompt'
    )
  })

  it('suppresses a stale prompt once a ready header follows it with nothing after', () => {
    const preview = [
      'Update available! 0.131.0 -> 0.132.0\n',
      'Press enter to continue\n',
      CODEX_READY_HEADER
    ].join('')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())).toBeNull()
    expect(isKnownReadyPromptPreview(preview)).toBe(true)
  })
})

describe('cursor approval + trust dismissal', () => {
  it('resolves an idle Cursor lane past its dismissed trust dialog (#8210)', () => {
    const preview = [
      'Cursor Agent\n',
      '⚠ Workspace Trust Required\n',
      'Do you trust the contents of this directory?\n',
      '  ▶ [a] Trust this workspace\n',
      '    [q] Quit\n',
      cursorReadyScreen()
    ].join('')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())).toBeNull()
    expect(isKnownReadyPromptPreview(preview)).toBe(true)
  })

  it('reports neither blocked nor ready for a busy Cursor lane past its dismissed trust dialog (#8210)', () => {
    // Why not a specific blockedReason: findCursorActivePromptIndex matches on the `→`
    // prompt glyph regardless of busy/idle, so the dismissed-modal check suppresses the
    // stale trust signal even while busy — the lane is honestly neither blocked nor idle,
    // matching the real runtime test's `.rejects.toThrow('timeout')` expectation.
    const preview = [
      'Cursor Agent\n',
      '⚠ Workspace Trust Required\n',
      'Do you trust the contents of this directory?\n',
      '  ▶ [a] Trust this workspace\n',
      '    [q] Quit\n',
      cursorBusyScreen()
    ].join('')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())).toBeNull()
    expect(isKnownReadyPromptPreview(preview)).toBe(false)
  })

  it('detects a live cursor-agent shell approval menu', () => {
    const preview = [
      'cursor-agent wants to run:',
      '  rm -rf build/',
      '',
      'Run this command?',
      '  Run (once) (enter)',
      '  Add to allowlist? (a)',
      '  Run everything (r)',
      '  Skip & tell the agent (esc)'
    ].join('\n')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())?.reason).toBe(
      'agent-approval-prompt'
    )
  })

  it('does not match narration of an approval choice, only the live menu', () => {
    const preview = [
      "I'll suggest Run Everything (as before) next time.",
      'Continuing with the plan.'
    ].join('\n')
    expect(findActionableTerminalWaitBlockedSignal(preview.toLowerCase())).toBeNull()
  })
})
