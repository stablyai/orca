import { describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from '../../ai-vault/resume/ai-vault-resume-command'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

describe('OpenCode 2 restored terminal launch mode', () => {
  it('retains an explicitly configured standalone command and quoted Unix session id', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'opencode2',
      providerSession: { key: 'session_id', id: 'session with spaces & $HOME' },
      cmdOverrides: { opencode2: 'mise exec -- team-opencode --standalone --port 4321' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(
      "mise exec -- team-opencode --standalone --port 4321 '--session' 'session with spaces & $HOME'"
    )
  })

  it('does not resume unsupported provider identities', () => {
    expect(
      buildAgentResumeStartupPlan({
        agent: 'opencode2',
        providerSession: { key: 'conversation_id', id: 'conversation' },
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toBeNull()
  })
})

describe('OpenCode 2 session-history launch mode', () => {
  it('preserves a standalone override and Windows command quoting in a folder workspace', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'opencode2',
        sessionId: 'session & one',
        cwd: 'C:\\Ada Lovelace\\folder',
        commandOverride: '"C:\\Agent Tools\\opencode2.cmd" --standalone',
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe(
      'cd /d "C:\\Ada Lovelace\\folder" && "C:\\Agent Tools\\opencode2.cmd" --standalone --session "session & one"'
    )
  })
})
