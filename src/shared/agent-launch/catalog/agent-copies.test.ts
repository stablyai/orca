import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../startup/tui-agent-startup'
import { structuredLaunchSeedOptions } from '../../native-chat/input/session-options/native-chat-session-option-defaults'
import { nativeChatPreferenceFor } from '../choices/structured-native-chat-launch-route'
import {
  agentCopyIdFromLaunchOptions,
  applyAgentCopy,
  applyAgentCopyById,
  captureAgentCopy,
  createAgentCopy,
  normalizeAgentCopies,
  resolveAgentSelection,
  type AgentCopy
} from './agent-copies'

const codeMode = {
  id: 'claude.code-mode',
  name: 'Claude code-mode',
  agent: 'claude' as const,
  command: '/opt/claude/bin/claude',
  args: '--model haiku',
  env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }
}

function launch(sessionOptions?: Record<string, string>) {
  const settings = {
    agentPermissionDefault: 'own' as const,
    agentDefaultArgs: { claude: '--verbose' },
    agentDefaultEnv: { claude: { BASE: '1' } },
    agentCopies: [codeMode]
  }
  return buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings,
      platform: 'linux',
      isRemote: false,
      shell: 'posix',
      ...(sessionOptions ? { sessionOptions } : {})
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
}

describe('agent copies', () => {
  it('starts a copy with its own command, arguments and environment', () => {
    const plan = launch({ agentCopy: 'claude.code-mode' })
    expect(plan?.launchCommand).toContain('/opt/claude/bin/claude')
    expect(plan?.launchCommand).toContain("'--model' 'haiku'")
    expect(plan?.launchCommand).not.toContain('--verbose')
    expect(plan?.env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' })
  })

  it('leaves the base agent on its own settings', () => {
    const plan = launch()
    expect(plan?.launchCommand).not.toContain('/opt/claude/bin/claude')
    expect(plan?.launchCommand).toContain('--verbose')
    expect(plan?.env).toEqual({ BASE: '1' })
  })

  it('refuses a copy the settings no longer have instead of starting the base agent', () => {
    expect(() => launch({ agentCopy: 'claude.gone' })).toThrow('Unknown agent copy "claude.gone"')
  })

  it('resolves built-in ids and saved copy ids, and nothing else', () => {
    const settings = { agentCopies: [codeMode] }
    expect(resolveAgentSelection('claude', settings)).toEqual({ agent: 'claude' })
    expect(resolveAgentSelection('claude.code-mode', settings)?.agent).toBe('claude')
    expect(resolveAgentSelection('claude.other', settings)).toBeNull()
    expect(resolveAgentSelection('nope.code-mode', settings)).toBeNull()
  })

  it('drops entries whose id does not name a built-in base or repeats an earlier id', () => {
    expect(
      normalizeAgentCopies([
        codeMode,
        { ...codeMode, name: 'Second' },
        { id: 'claude', name: 'Shadow' },
        { id: 'unknown.copy', name: 'Unknown base' },
        { id: 'codex.Upper', name: 'Bad slug' }
      ]).map((copy) => copy.id)
    ).toEqual(['claude.code-mode'])
  })

  it('duplicates the agent as configured now, under a unique id', () => {
    const copy = createAgentCopy('claude', 'Claude Haiku', {
      agentCopies: [{ id: 'claude.claude-haiku', name: 'Claude Haiku', agent: 'claude' }],
      agentCmdOverrides: { claude: 'claude-wrapper' },
      agentDefaultArgs: { claude: '--model haiku' },
      agentDefaultEnv: { claude: { A: 'b' } }
    })
    expect(copy).toEqual({
      id: 'claude.claude-haiku-2',
      name: 'Claude Haiku',
      agent: 'claude',
      command: 'claude-wrapper',
      args: '--model haiku',
      env: { A: 'b' }
    })
  })

  it('reads a copy from either launch option map and refuses two different ones', () => {
    expect(
      agentCopyIdFromLaunchOptions({ model: 'haiku' }, { agentCopy: 'claude.code-mode' })
    ).toBe('claude.code-mode')
    expect(() =>
      agentCopyIdFromLaunchOptions({ agentCopy: 'claude.a' }, { agentCopy: 'claude.b' })
    ).toThrow('Conflicting agent copies "claude.a" and "claude.b"')
  })

  it("fills its agent's slots with the copy's model, permission and surface, and reads them back", () => {
    const copy: AgentCopy = {
      ...codeMode,
      choices: { model: 'haiku', options: { effort: 'low' } },
      permission: 'full-access',
      chat: true
    }
    const base = {
      agentCmdOverrides: { claude: 'claude', codex: 'codex-wrapper' },
      agentLaunchChoices: { claude: { model: 'opus' }, codex: { model: 'gpt' } },
      agentPermissionOverrides: { claude: 'ask' as const },
      nativeChatProviders: { claude: false, codex: true },
      agentCopies: [copy]
    }
    const applied = applyAgentCopy(base, copy)
    expect(applied.agentCmdOverrides).toEqual({
      claude: '/opt/claude/bin/claude',
      codex: 'codex-wrapper'
    })
    expect(applied.agentLaunchChoices).toEqual({
      claude: { model: 'haiku', options: { effort: 'low' } },
      codex: { model: 'gpt' }
    })
    expect(applied.agentPermissionOverrides).toEqual({ claude: 'full-access' })
    expect(nativeChatPreferenceFor(applied, 'claude')).toBe(true)
    expect(nativeChatPreferenceFor(applied, 'codex')).toBe(true)
    expect(captureAgentCopy(copy, applied)).toEqual(copy)
  })

  it("leaves the agent's slot empty where the copy has no value of its own", () => {
    const applied = applyAgentCopy(
      {
        agentPermissionOverrides: { claude: 'ask' as const },
        nativeChatProviders: { claude: true }
      },
      { id: 'claude.plain', name: 'Plain', agent: 'claude' }
    )
    expect(applied.agentPermissionOverrides).toEqual({})
    expect(applied.nativeChatProviders).toEqual({})
  })

  it("seeds a copy's chat with the copy's model and options, not its agent's", () => {
    const copy: AgentCopy = { ...codeMode, choices: { model: 'haiku' } }
    const settings = { agentLaunchChoices: { claude: { model: 'opus' } }, agentCopies: [copy] }
    expect(structuredLaunchSeedOptions(applyAgentCopy(settings, copy), 'claude')?.model).toBe(
      'haiku'
    )
    expect(structuredLaunchSeedOptions(settings, 'claude')?.model).toBe('opus')
  })

  it('keeps the new card values of a saved copy and drops malformed ones', () => {
    const [copy] = normalizeAgentCopies([
      { ...codeMode, choices: { model: 'haiku' }, permission: 'auto', chat: false, disabled: true }
    ])
    expect(copy).toMatchObject({
      choices: { model: 'haiku' },
      permission: 'auto',
      chat: false,
      disabled: true
    })
    const [bad] = normalizeAgentCopies([
      { ...codeMode, permission: 'root', chat: 'yes', disabled: 1 }
    ])
    expect(bad).not.toHaveProperty('permission')
    expect(bad).not.toHaveProperty('chat')
    expect(bad).not.toHaveProperty('disabled')
  })

  it('applies a copy by id and leaves the settings as they are without one it knows', () => {
    const settings = { agentCmdOverrides: {}, agentCopies: [codeMode] }
    expect(applyAgentCopyById(settings, 'claude.code-mode').agentCmdOverrides).toEqual({
      claude: '/opt/claude/bin/claude'
    })
    expect(applyAgentCopyById(settings, 'claude.gone')).toBe(settings)
    expect(applyAgentCopyById(settings, undefined)).toBe(settings)
  })
})
