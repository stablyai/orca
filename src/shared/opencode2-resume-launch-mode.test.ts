import { describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import type { AgentStartupShell } from './tui-agent-startup-shell'

const providerSession = { key: 'session_id', id: 'ses_resume' } as const
const hosts: { platform: NodeJS.Platform; shell: AgentStartupShell; resumeArgs: string }[] = [
  { platform: 'darwin', shell: 'posix', resumeArgs: "'--session' 'ses_resume'" },
  { platform: 'linux', shell: 'posix', resumeArgs: "'--session' 'ses_resume'" },
  { platform: 'win32', shell: 'powershell', resumeArgs: "'--session' 'ses_resume'" },
  { platform: 'win32', shell: 'cmd', resumeArgs: '"--session" "ses_resume"' }
]

describe('OpenCode 2 restored terminal launch mode', () => {
  it.each(hosts)('keeps the default standalone flag once on $platform/$shell', (host) => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'opencode2',
      providerSession,
      cmdOverrides: {},
      ...host
    })

    expect(plan?.launchCommand).toBe(`opencode2 --standalone ${host.resumeArgs}`)
  })

  it.each(hosts)('honors a shared-service alias on $platform/$shell', (host) => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'opencode2',
      providerSession,
      cmdOverrides: { opencode2: 'team-opencode --port 4321' },
      ...host,
      isRemote: true
    })

    expect(plan?.launchCommand).toBe(`team-opencode --port 4321 ${host.resumeArgs}`)
    expect(plan?.launchConfig.agentCommand).toBe('team-opencode --port 4321')
  })

  it.each(hosts)(
    'keeps the captured command instead of current defaults on $platform/$shell',
    (host) => {
      const plan = buildAgentResumeStartupPlan({
        agent: 'opencode2',
        providerSession,
        cmdOverrides: { opencode2: 'opencode2 --standalone' },
        agentCommand: 'saved-opencode --port 4321',
        ...host
      })

      expect(plan?.launchCommand).toBe(`saved-opencode --port 4321 ${host.resumeArgs}`)
    }
  )

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
  it.each(hosts)('keeps the default standalone flag once on $platform/$shell', (host) => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'opencode2',
        sessionId: providerSession.id,
        cwd: null,
        ...host
      })
    ).toBe(
      host.shell === 'cmd'
        ? 'opencode2 --standalone --session "ses_resume"'
        : "opencode2 --standalone --session 'ses_resume'"
    )
  })

  it.each(hosts)('honors an override without standalone on $platform/$shell', (host) => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'opencode2',
        sessionId: providerSession.id,
        cwd: null,
        commandOverride: 'team-opencode --port 4321',
        ...host
      })
    ).toBe(
      host.shell === 'cmd'
        ? 'team-opencode --port 4321 --session "ses_resume"'
        : "team-opencode --port 4321 --session 'ses_resume'"
    )
  })

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

  it('leaves OpenCode 1 history commands unchanged', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'opencode',
        sessionId: providerSession.id,
        cwd: '/repo/folder',
        platform: 'linux'
      })
    ).toBe("cd '/repo/folder' && opencode --session 'ses_resume'")
  })
})
