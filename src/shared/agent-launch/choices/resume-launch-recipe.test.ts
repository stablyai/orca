import { describe, expect, it } from 'vitest'
import { resolveResumeLaunchRecipe } from './resume-launch-recipe'
import { buildAgentResumeStartupPlan } from '../startup/tui-agent-resume-startup'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'

const session = { key: 'session_id', id: 'abc' } as const

describe('resolveResumeLaunchRecipe without a recorded launch', () => {
  it('adds the model the session recorded, and leaves a recorded launch to its own arguments', () => {
    const withModel = { ...session, permissionMode: 'bypassPermissions', model: 'lane-model-7' }
    const recorded = { agentArgs: '--model lane-model-3', agentEnv: {} }

    expect(resolveResumeLaunchRecipe(undefined, 'claude', withModel).agentArgs).toBe(
      '--dangerously-skip-permissions --model lane-model-7'
    )
    expect(resolveResumeLaunchRecipe(recorded, 'claude', withModel).agentArgs).toBe(
      '--model lane-model-3'
    )
  })
})

describe('the restart command for a recorded model, per shell', () => {
  const SHELLS = ['posix', 'powershell', 'cmd'] as const

  function restartLine(model: string, shell: AgentStartupShell) {
    const providerSession = { ...session, model }
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      ...resolveResumeLaunchRecipe(undefined, 'claude', providerSession)
    })
    const line = plan?.launchCommand ?? ''
    const parsed = tokenizeStartupCommand(line, shell)
    return { line, tokens: parsed.ok ? parsed.tokens : [] }
  }

  it.each(SHELLS)(
    'passes a model id as one %s argument and leaves out one with a space, a quote and a semicolon',
    (shell) => {
      const { tokens } = restartLine('vertex-x@2025:a/b[1m]', shell)
      const hostile = restartLine(`lane-7"; echo broke 'x`, shell)

      expect(tokens.slice(1)).toEqual(['--model', 'vertex-x@2025:a/b[1m]', '--resume', 'abc'])
      expect(hostile.tokens.slice(1)).toEqual(['--resume', 'abc'])
      expect(hostile.line).not.toContain('broke')
    }
  )
})
