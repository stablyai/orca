import { describe, expect, it } from 'vitest'
import { isCodexRestartEligiblePane } from './codex-pane-restart-eligibility'

describe('isCodexRestartEligiblePane', () => {
  it('accepts a pane whose foreground is Codex itself', () => {
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'codex', hasChildProcesses: false },
        launchAgent: undefined
      })
    ).toBe(true)
  })

  it('accepts the shipped Codex binary name and the Windows .exe suffix', () => {
    for (const foregroundProcess of ['codex-aarch64-ap', 'codex.exe']) {
      expect(
        isCodexRestartEligiblePane({
          inspection: { foregroundProcess, hasChildProcesses: false },
          launchAgent: undefined
        })
      ).toBe(true)
    }
  })

  it('accepts a launcher-started Codex pane whose deepest process is a subagent', () => {
    // Windows reports pwsh -> node -> codex.exe -> claude.exe as "claude".
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'claude.exe', hasChildProcesses: true },
        launchAgent: 'codex'
      })
    ).toBe(true)
  })

  it('accepts a launcher-started Codex pane whose wrapper has not resolved to an agent yet', () => {
    // Windows reports pwsh while the descendant scan warms up, then `node`
    // (the `node .../bin/codex` wrapper) before it resolves to "codex".
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'node', hasChildProcesses: true },
        launchAgent: 'codex'
      })
    ).toBe(true)
  })

  it('rejects a Codex-launched pane the user exited and is now typing into', () => {
    // Why: the process scans only ever surface a recognized agent or the shell,
    // so `less`/`vim`/`ssh` means Codex is gone — and a notice would eat the
    // keystrokes the user needs to leave that program.
    for (const foregroundProcess of ['less', 'vim', 'ssh', 'tmux', 'git']) {
      expect(
        isCodexRestartEligiblePane({
          inspection: { foregroundProcess, hasChildProcesses: true },
          launchAgent: 'codex'
        })
      ).toBe(false)
    }
  })

  it('rejects a Codex-launched pane the user exited back to a shell prompt', () => {
    // A restart notice drops every keystroke, so a bare prompt must stay unmarked.
    for (const foregroundProcess of ['pwsh.exe', 'powershell.exe', 'bash', 'zsh']) {
      expect(
        isCodexRestartEligiblePane({
          inspection: { foregroundProcess, hasChildProcesses: false },
          launchAgent: 'codex'
        })
      ).toBe(false)
    }
  })

  it('rejects a Codex-launched pane whose shell is reported with no live child', () => {
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'pwsh.exe', hasChildProcesses: true },
        launchAgent: 'codex'
      })
    ).toBe(false)
  })

  it('rejects a non-Codex pane with a live child process', () => {
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'claude.exe', hasChildProcesses: true },
        launchAgent: 'claude'
      })
    ).toBe(false)
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: 'node', hasChildProcesses: true },
        launchAgent: undefined
      })
    ).toBe(false)
  })

  it('rejects a pane whose process could not be read', () => {
    expect(
      isCodexRestartEligiblePane({
        inspection: { foregroundProcess: null, hasChildProcesses: false },
        launchAgent: 'codex'
      })
    ).toBe(false)
    // Why: a stale remote handle reports the last-known name; it is not evidence.
    expect(
      isCodexRestartEligiblePane({
        inspection: {
          foregroundProcess: null,
          hasChildProcesses: false,
          verdict: 'unverifiable',
          reason: 'terminal_gone'
        },
        launchAgent: 'codex'
      })
    ).toBe(false)
  })
})
