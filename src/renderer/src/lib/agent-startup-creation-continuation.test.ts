import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { buildQuickComposerStartup } from '../hooks/composer-state/quick-startup-plan'
import { buildAgentResumeStartupPlan } from '../../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'
import {
  buildAiVaultLocalResumeStartup,
  buildAiVaultForkStartup,
  resolveAiVaultCopiedSessionAgentArgs
} from '../../../shared/ai-vault-resume-startup'
import { buildAntigravityReferenceStartup } from './ai-vault-antigravity-reference-startup'
vi.mock('@/lib/telemetry', () => ({ tuiAgentToAgentKind: (agent: string) => agent }))

it.each(['claude', 'codex'] as const)(
  'retains typed %s seeds through actual quick creation, backend forwarding and resume',
  (agent) => {
    const settings = {
      ...getDefaultSettings('/test'),
      agentPermissionDefault: 'own' as const,
      agentDefaultArgs: { [agent]: '--verbose' },
      agentLaunchChoices: { [agent]: { model: 'org\\model', options: { effort: 'high' } } }
    }
    const result = buildQuickComposerStartup({
      agent,
      prompt: '',
      draftPrompt: null,
      settings,
      launchHost: { kind: 'known', platform: 'win32', hostKind: 'local' },
      shell: 'powershell',
      isRemote: false,
      telemetrySource: undefined
    })
    const plan = result.startupPlan
    expect(plan).not.toBeNull()
    const words = tokenizeStartupCommand(plan?.launchCommand ?? '', 'powershell')
    expect(words).toMatchObject({
      ok: true,
      tokens: expect.arrayContaining([agent === 'codex' ? '-m' : '--model', 'org\\model'])
    })
    expect(plan?.launchCommand).not.toContain('configured')
    expect(plan?.launchConfig.agentArgs).toBe('--verbose')
    expect(result.backendStartup).toMatchObject({
      launchConfig: plan?.launchConfig,
      sessionOptions: { model: 'org\\model', effort: 'high' }
    })
    const resume = buildAgentResumeStartupPlan({
      agent,
      providerSession: { key: 'session_id', id: 'existing' },
      platform: 'win32',
      shell: 'powershell',
      cmdOverrides: {},
      ...plan?.launchConfig
    })
    expect(resume?.launchCommand).toContain('--verbose')
    expect(resume?.launchCommand).not.toContain('org')
    expect(resume?.launchCommand).not.toContain('high')
  }
)

it.each(['claude', 'codex'] as const)(
  'preserves %s continuation, fork and copy raw without a fresh authored map',
  (agent) => {
    const settings = {
      ...getDefaultSettings('/test'),
      agentPermissionDefault: 'own' as const,
      agentDefaultArgs: { [agent]: '--model literal' },
      agentDefaultEnv: { [agent]: { KEEP: 'yes' } },
      agentLaunchChoices: { [agent]: { model: 'fresh-only', options: { effort: 'high' } } }
    }
    const args = {
      session: { agent, sessionId: 'existing', cwd: '/project/sub', codexHome: null },
      host: { platform: 'linux' as const, liveShell: 'posix' as const, codexHome: null },
      settings
    }
    const resume = buildAiVaultLocalResumeStartup({ ...args, embedCwd: false })
    expect(resume.command).toContain('literal')
    expect(resume.command).toContain('existing')
    expect(resume).toMatchObject({ cwd: '/project/sub', env: { KEEP: 'yes' } })
    const fork = buildAiVaultForkStartup(args)
    expect(fork?.command).toContain('literal')
    expect(fork?.command).toContain('fork')
    expect(fork?.providerSession).toBeUndefined()
    expect(resolveAiVaultCopiedSessionAgentArgs({ ...args, sourceAgent: agent })).toBe(
      '--model literal'
    )
    for (const result of [resume, fork]) {
      expect(result?.command).not.toContain('fresh-only')
      expect(result?.command).not.toContain('high')
    }
    expect(
      buildAiVaultLocalResumeStartup({ ...args, embedCwd: false, agentArgs: '--model picked' })
        .command
    ).toContain('picked')
  }
)

it('uses fresh typed defaults for an Antigravity reference rather than continuing its provider identity', () => {
  const settings = {
    ...getDefaultSettings('/test'),
    agentPermissionDefault: 'own' as const,
    agentLaunchChoices: { antigravity: { model: 'fresh-reference' } },
    agentDefaultArgs: { antigravity: '--verbose' }
  }
  const result = buildAntigravityReferenceStartup({
    settings,
    platform: 'linux',
    shell: 'posix',
    cwd: '/project',
    session: {
      sessionId: 'reference',
      filePath: '/home/test/.gemini/antigravity-ide/brain/reference/transcript_full.jsonl'
    }
  })
  expect(result?.command).toContain('fresh-reference')
  expect(result?.command).not.toContain('--conversation')
  expect(result?.launchConfig?.agentArgs).toBe('--verbose')
})
