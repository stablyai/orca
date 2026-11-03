import { describe, expect, it } from 'vitest'
import {
  agentPickerChoiceSeeds,
  agentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'
import { editAgentPickerPermission } from './agent-launch-picker-permission'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { AgentStartupSettings } from './agent-startup-plan-inputs'

function launch(settings: AgentStartupSettings, shell: AgentStartupShell, isRemote = false) {
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'kimi',
      settings,
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      isRemote
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  if (!plan) {
    throw new Error('Kimi launch failed')
  }
  const parsed = tokenizeStartupCommand(plan.launchCommand, shell)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return { tokens: parsed.tokens, recorded: plan.launchConfig.agentCommand }
}

describe.each(['posix', 'powershell', 'cmd'] as const)('Kimi permissions in %s', (shell) => {
  it.each([false, true])('launches Full access in Never Ask mode, remote=%s', (isRemote) => {
    const result = launch({ agentPermissionDefault: 'full-access' }, shell, isRemote)
    expect(result.tokens).toEqual(['kimi', '--auto'])
    expect(result.recorded).toContain('--auto')
  })

  it.each(['--yolo', '-y', '--yes', '--auto-approve', '--auto', '-cy', '-yc', '-Cy', '-ymcustom'])(
    'lets explicit Arguments %s own the permission',
    (flag) => {
      const result = launch(
        { agentPermissionDefault: 'full-access', agentDefaultArgs: { kimi: flag } },
        shell
      )
      expect(result.tokens).toEqual(['kimi', flag])
      expect(result.recorded).toContain(flag)
    }
  )

  it('recognizes the consuming shell spelling of an explicit permission', () => {
    const flag = shell === 'powershell' ? '--yo`lo' : shell === 'cmd' ? '--yo^lo' : '--yo\\lo'
    expect(
      launch({ agentPermissionDefault: 'full-access', agentDefaultArgs: { kimi: flag } }, shell)
        .tokens
    ).toEqual(['kimi', '--yolo'])
  })

  it.each(['npx -y @moonshot-ai/kimi-code', 'my-kimi'])(
    'keeps the launcher %s and applies Full access',
    (command) => {
      const result = launch(
        { agentPermissionDefault: 'full-access', agentCmdOverrides: { kimi: command } },
        shell
      )
      expect(result.tokens).toEqual([...command.split(' '), '--auto'])
    }
  )
})

it.each(['-cy', '-Cy', '-ymcustom'])(
  'keeps bundled Kimi Arguments %s intact when editing permissions',
  (flag) => {
    const entry: AgentPickerEntry = {
      agent: 'kimi',
      label: 'Kimi',
      rows: [{ kind: 'terminal', agent: 'kimi' }],
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      catalog: { origin: 'unknown' },
      ...agentPickerChoiceSeeds('kimi', {
        agentPermissionDefault: 'full-access',
        agentDefaultArgs: { kimi: flag }
      })
    }
    expect(editAgentPickerPermission(entry, agentPickerDraft(entry), 'full-access').arguments).toBe(
      flag
    )
  }
)
