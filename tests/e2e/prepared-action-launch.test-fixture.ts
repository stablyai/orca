import { eraseRpcMethods, type RpcContext } from '../../src/main/runtime/rpc/core'
import { TERMINAL_LIFECYCLE_METHODS } from '../../src/main/runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { expect, vi } from 'vitest'
import { normalizeSourceControlAiActionDefaults } from '../../src/shared/source-control-ai-actions'
import { sourceControlActionLaunchOptions } from '../../src/shared/source-control-action-launch-preferences'
import { agentLaunchNeedsPreparedCommand } from '../../src/shared/agent-launch-preferences'
import { resolveAgentStartupPlanInputs } from '../../src/shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../src/shared/tui-agent-startup'
import { resolveAgentSessionOptionLaunch } from '../../src/shared/agent-session-option-launch-legacy.test-fixture'
import {
  OrcaRuntimeWithResolveMobileSessionTerminalCommand,
  type MobileTerminalCommandOptions
} from '../../src/main/runtime/terminal/launch/mobile-terminal-startup'

vi.mock('../../src/main/runtime/terminal/launch/mobile-terminal-renderer-create', () => ({
  OrcaRuntimeWithRunCreateMobileSessionTerminal: class {}
}))

abstract class PreparedMobileCommandHost extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
  static get commandResolver() {
    return this.prototype.resolveMobileSessionTerminalCommand
  }
}

type PreparedTerminalCreateContext = Pick<RpcContext, 'pairedDeviceId' | 'clientKind'> & {
  runtime: Pick<RpcContext['runtime'], 'createTerminal' | 'dedupeTerminalCreate'>
}

type PreparedTerminalCreateMethod = {
  handler(params: unknown, context: PreparedTerminalCreateContext): unknown
}

export function independentActionEffortPlan(agent: 'claude' | 'codex') {
  const recipe = normalizeSourceControlAiActionDefaults({
    fixChecks: {
      agentId: agent,
      launchPreferences: { agentId: agent, options: { effort: 'high' } }
    }
  })?.fixChecks
  expect(recipe?.launchPreferences).toEqual({
    agentId: agent,
    modelSelection: {
      base: 'default',
      options: { effort: { agentId: agent, value: 'high' } }
    }
  })
  const { sessionOptions } = sourceControlActionLaunchOptions(recipe ?? {}, agent)
  expect(sessionOptions).toEqual({ effort: 'high' })
  expect(resolveAgentSessionOptionLaunch(agent, sessionOptions)).toEqual({
    args: [],
    appliedValues: {}
  })
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent,
      settings: { agentPermissionDefault: 'own' },
      platform: 'linux',
      isRemote: true,
      shell: 'posix',
      agentArgs: '--verbose',
      sessionOptions
    }),
    agentEnv: { ACTION_PROFILE: 'captured' },
    prompt: 'Fix checks'
  })
  if (!plan) {
    throw new Error('Missing action startup plan')
  }
  expect(plan.sessionOptions).toEqual({ effort: 'high' })
  expect(plan.launchCommand).toBe(
    agent === 'claude'
      ? "claude '--verbose' '--effort' 'high' 'Fix checks'"
      : "codex '--verbose' '-c' 'model_reasoning_effort=high' 'Fix checks'"
  )
  expect(agentLaunchNeedsPreparedCommand(agent, plan.sessionOptions)).toBe(true)
  return plan
}

export async function consumeOldHostPreparedCommand(params: MobileTerminalCommandOptions) {
  const consume = PreparedMobileCommandHost.commandResolver
  if (typeof consume !== 'function' || !params.command) {
    throw new Error('Expected a complete prepared command')
  }
  return await consume.call(
    {},
    { id: 'wt-1', path: '/repo', connectionId: null, repo: null, folderWorkspace: null },
    params
  )
}

// The prepared handler matches the pinned host when resumeOrigin is absent.
export async function consumePreparedBackgroundCommand(
  params: unknown,
  createTerminal: PreparedTerminalCreateContext['runtime']['createTerminal']
) {
  const method = eraseRpcMethods(TERMINAL_LIFECYCLE_METHODS).find(
    (method) => method.name === 'terminal.create'
  )
  if (!method?.params) {
    throw new Error('Missing terminal.create method')
  }
  const parsed = method.params.parse(params)
  const dedupeTerminalCreate = vi.fn<
    PreparedTerminalCreateContext['runtime']['dedupeTerminalCreate']
  >(async (_identity, worktree, _mutation, _reconcile, create) =>
    create(worktree, 'reserved-handle')
  )
  const handler: PreparedTerminalCreateMethod['handler'] = method.handler
  const context: PreparedTerminalCreateContext = {
    runtime: { createTerminal, dedupeTerminalCreate },
    pairedDeviceId: 'paired-current',
    clientKind: 'runtime'
  }
  const result = await handler(parsed, context)
  expect(dedupeTerminalCreate).toHaveBeenCalledExactlyOnceWith(
    'paired-current',
    'id:wt-1',
    undefined,
    false,
    expect.any(Function)
  )
  return result
}
