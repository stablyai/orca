import { describe, expect, it } from 'vitest'
import {
  agentResumeCommandSchema,
  resolveAgentResumeCommand,
  resolveAgentResumeDeliveryCommand
} from './agent-resume-command'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const request = {
  agent: 'codex' as const,
  providerSession: { key: 'session_id' as const, id: 'session-1' },
  cmdOverrides: {},
  agentArgs: '--add-dir "C:\\work (x86)\\repo"'
}

describe('process-owner agent resume commands', () => {
  it('rebuilds the renderer preview for the selected shell', () => {
    const preview = buildAgentResumeStartupPlan({ ...request, platform: 'win32' })!
    expect(preview.launchCommand).toContain("'resume'")
    expect(resolveAgentResumeCommand(preview.agentResume, 'cmd.exe')).toBe(
      'codex "--add-dir" "C:\\work (x86)\\repo" "resume" "session-1"'
    )
    expect(resolveAgentResumeCommand(preview.agentResume, 'powershell.exe')).toBe(
      preview.launchCommand
    )
  })

  it('preserves argument values across a PowerShell-to-cmd fallback', () => {
    expect(
      resolveAgentResumeCommand(
        { ...request, sourceShell: 'powershell', agentArgs: '--add-dir C:\\a^b\\' },
        'cmd.exe'
      )
    ).toBe('"codex" "--add-dir" "C:\\a^b\\\\" "resume" "session-1"')
  })

  it('cleans persisted Claude selectors when the configured shell falls back', () => {
    const command = resolveAgentResumeCommand(
      {
        ...request,
        agent: 'claude',
        sourceShell: 'powershell',
        agentCommand: "& claude '--model' 'sonnet' --resume 'old-session'"
      },
      'cmd.exe'
    )
    expect(command).toBe('"claude" "--model" "sonnet" "--resume" "session-1"')
  })

  it('refuses to reinterpret a shell-specific custom script on another shell', () => {
    const custom = {
      ...request,
      sourceShell: 'powershell' as const,
      agentCommand: 'claude --model $env:MODEL'
    }
    expect(resolveAgentResumeCommand(custom, 'powershell.exe')).toContain('$env:MODEL')
    expect(() => resolveAgentResumeCommand(custom, 'cmd.exe')).toThrow()
  })

  it('preserves session options when rebuilding for cmd', () => {
    const preview = buildAgentResumeStartupPlan({
      ...request,
      platform: 'win32',
      sessionOptions: { model: 'gpt-5' }
    })!
    expect(resolveAgentResumeCommand(preview.agentResume, 'cmd.exe')).toContain('"gpt-5"')
    expect(
      resolveAgentResumeCommand({ ...preview.agentResume!, sourceShell: 'powershell' }, 'cmd.exe')
    ).toContain('"gpt-5"')
  })

  it('uses POSIX resume quoting for the actual WSL shell', () => {
    expect(
      resolveAgentResumeCommand({ ...request, agentArgs: '--add-dir /home/user/repo' }, 'wsl.exe')
    ).toBe("codex '--add-dir' '/home/user/repo' 'resume' 'session-1'")
  })

  it('leaves legacy command-only requests unchanged', () => {
    expect(resolveAgentResumeCommand(undefined, 'cmd.exe', 'custom-command')).toBe('custom-command')
  })

  it('drops an untranslatable resume at delivery time instead of failing the spawn', () => {
    const custom = {
      ...request,
      sourceShell: 'powershell' as const,
      agentCommand: 'claude --model $env:MODEL'
    }
    expect(resolveAgentResumeDeliveryCommand(custom, 'powershell.exe')).toContain('$env:MODEL')
    expect(resolveAgentResumeDeliveryCommand(custom, 'cmd.exe')).toBeUndefined()
  })

  it('rejects malformed structured requests', () => {
    expect(() =>
      agentResumeCommandSchema.parse({ ...request, providerSession: { id: '' } })
    ).toThrow()
    // Boundary hygiene: ids reach a live shell, so control characters must not parse.
    expect(() =>
      agentResumeCommandSchema.parse({
        ...request,
        providerSession: { key: 'session_id', id: 'session-1\rwhoami' }
      })
    ).toThrow()
  })
})
