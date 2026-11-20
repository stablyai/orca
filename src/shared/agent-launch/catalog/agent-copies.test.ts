import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../startup/tui-agent-startup'
import { createAgentCopy, normalizeAgentCopies, resolveAgentSelection } from './agent-copies'

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
})
