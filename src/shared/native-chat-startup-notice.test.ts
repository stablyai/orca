import { describe, expect, it } from 'vitest'
import {
  buildNativeChatStartupPhaseNotice,
  isAgentStartupSettled,
  readNativeChatStartupNotice,
  readTerminalActivityTail
} from './native-chat-startup-notice'

const CODEX_READY_HEADER = [
  ' >_ OpenAI Codex (v0.132.0)\n',
  ' model:       gpt-5.5 high   /model to change\n',
  ' directory:   ~/orca/workspaces/orca/cli-debug\n'
].join('')

// Real capture, verbatim (line-wrapped only for readability here), from the reported
// Windows PTY update flow: authorize → npm install runs → restart required → shell prompt.
const UPDATE_RUNNING_CAPTURE = [
  'Updating Codex via `npm install -g @openai/codex`...',
  'npm warn cleanup Failed to remove some directories [',
  "npm warn cleanup   'C:\\\\Users\\\\visuz\\\\AppData\\\\Local\\\\nvm\\\\v24.8.0\\\\node_modules\\\\@openai\\\\.codex-Lrx46Vb0',",
  '',
  'added 5 packages, and changed 2 packages in 30s'
].join('\n')

const RESTART_REQUIRED_CAPTURE = [
  UPDATE_RUNNING_CAPTURE,
  '',
  '🎉 Update ran successfully! Please restart Codex.',
  'PS C:\\Users\\visuz\\orca\\workspaces\\productfactory-monorepo\\comber>'
].join('\n')

describe('readNativeChatStartupNotice', () => {
  it('returns a prompt notice with parsed numbered options for the update dialog', () => {
    const screen = [
      'Update available! 0.145.0 -> 0.146.0',
      '1. Update now',
      '2. Skip',
      'Press enter to continue'
    ].join('\n')
    const notice = readNativeChatStartupNotice(screen)
    expect(notice?.phase).toBe('prompt')
    expect(notice?.reason).toBe('codex-update-prompt')
    expect(notice?.title).toBe('Codex has an update')
    expect(notice?.options).toEqual([
      { label: 'Update now', send: '1' },
      { label: 'Skip', send: '2' }
    ])
  })

  it('falls back to a single Continue option when the dialog has no numbered menu', () => {
    const screen = [
      'Choose working directory to resume this session',
      '  Session = latest cwd recorded in the resumed session',
      '  Press enter to continue'
    ].join('\n')
    const notice = readNativeChatStartupNotice(screen)
    expect(notice?.reason).toBe('codex-cwd-prompt')
    expect(notice?.options).toEqual([{ label: 'Continue', send: '\r' }])
  })

  it('falls back to a Trust option for a bare press-t-to-trust dialog', () => {
    const screen = ['Do you trust this workspace directory?', 'Press t to trust'].join('\n')
    const notice = readNativeChatStartupNotice(screen)
    expect(notice?.reason).toBe('codex-trust-workspace')
    expect(notice?.options).toEqual([{ label: 'Trust', send: 't' }])
  })

  it('detects the running phase from the real update-in-progress capture', () => {
    const notice = readNativeChatStartupNotice(UPDATE_RUNNING_CAPTURE)
    expect(notice?.phase).toBe('running')
    expect(notice?.reason).toBeNull()
    expect(notice?.options).toEqual([])
    expect(notice?.body.some((line) => line.includes('added 5 packages'))).toBe(true)
  })

  it('detects the restart-required phase from the real post-update capture', () => {
    const notice = readNativeChatStartupNotice(RESTART_REQUIRED_CAPTURE)
    expect(notice?.phase).toBe('restart-required')
    expect(notice?.body.some((line) => line.includes('Please restart Codex'))).toBe(true)
  })

  it('prefers restart-required over a running marker still present in the same viewport', () => {
    // Why: the running log usually stays in the same viewport once the success banner
    // prints below it, so the most-advanced phase must win.
    const notice = readNativeChatStartupNotice(RESTART_REQUIRED_CAPTURE)
    expect(notice?.phase).toBe('restart-required')
  })

  it('returns null for a settled, ready Codex screen', () => {
    expect(readNativeChatStartupNotice(CODEX_READY_HEADER)).toBeNull()
  })

  it('returns null for plain shell output with no dialog markers', () => {
    const screen = 'PS C:\\Users\\visuz\\repo> git status\nOn branch main\nnothing to commit\n'
    expect(readNativeChatStartupNotice(screen)).toBeNull()
  })

  it('strips ANSI SGR styling before matching markers', () => {
    const styled =
      '\x1b[33mUpdate available! 0.145.0 -> 0.146.0\x1b[0m\n\x1b[32mPress enter to continue\x1b[0m\n'
    expect(readNativeChatStartupNotice(styled)?.reason).toBe('codex-update-prompt')
  })
})

describe('isAgentStartupSettled', () => {
  it('is true for a ready Codex header', () => {
    expect(isAgentStartupSettled(CODEX_READY_HEADER)).toBe(true)
  })

  it('is false while the update dialog is showing', () => {
    expect(
      isAgentStartupSettled(
        ['Update available! 0.145.0 -> 0.146.0', 'Press enter to continue'].join('\n')
      )
    ).toBe(false)
  })

  it('is false right after the restart-required banner (no ready header yet)', () => {
    expect(isAgentStartupSettled(RESTART_REQUIRED_CAPTURE)).toBe(false)
  })
})

describe('readTerminalActivityTail', () => {
  it('caps to the last N non-blank lines', () => {
    const screen = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const tail = readTerminalActivityTail(screen, 5)
    expect(tail).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19'])
  })

  it('drops blank lines', () => {
    expect(readTerminalActivityTail('a\n\n\nb\n', 10)).toEqual(['a', 'b'])
  })
})

describe('buildNativeChatStartupPhaseNotice', () => {
  it('builds an update-failed notice carrying the last observed log tail', () => {
    const notice = buildNativeChatStartupPhaseNotice('update-failed', UPDATE_RUNNING_CAPTURE)
    expect(notice.phase).toBe('update-failed')
    expect(notice.reason).toBeNull()
    expect(notice.options).toEqual([])
    expect(notice.title).toBe('Codex update did not finish')
  })

  it('builds a restarting notice', () => {
    const notice = buildNativeChatStartupPhaseNotice('restarting', RESTART_REQUIRED_CAPTURE)
    expect(notice.phase).toBe('restarting')
    expect(notice.title).toBe('Restarting Codex…')
  })
})
