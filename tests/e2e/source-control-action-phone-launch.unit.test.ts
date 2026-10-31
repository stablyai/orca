import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import type { RpcResponse } from '../../mobile/src/transport/types'
import { launchAgentWithPrompt } from '../../mobile/src/session/pr-ai-triage-launch'
import type { SourceControlActionRecipe } from '../../src/shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../src/shared/source-control-ai-types'
import type { TuiAgent } from '../../src/shared/tui-agent'
import { liftActionPermissionArgs } from '../../src/shared/source-control-action-permission-lift'
import { AgentLaunchReplay } from '../../src/shared/rpc-contract/agent-launch-params'
import { resolveAgentStartupPlanInputs } from '../../src/shared/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../src/shared/tui-agent-launch-command'

vi.mock('../../mobile/src/platform/random-v4-uuid', () => ({
  randomV4Uuid: () => randomUUID()
}))

it('carries the selected raw group and typed choices through the phone request to host compilation', async () => {
  const global: SourceControlActionRecipe = {
    agentId: 'claude',
    surface: 'terminal',
    launchPreferences: {
      agentId: 'claude',
      model: 'opus',
      options: { effort: 'high' },
      permissionMode: 'ask'
    }
  }
  type Row = {
    global: SourceControlActionRecipe
    repo: NonNullable<RepoSourceControlAiOverrides['actionOverrides']>['fixChecks']
    agent?: TuiAgent
    defaultAgent?: TuiAgent | 'blank'
    raw?: string
    options?: Record<string, string>
    applied: Record<string, string>
    command: string
  }
  const rows: Row[] = [
    undefined,
    '',
    null,
    '--verbose',
    '--effort low --dangerously-skip-permissions'
  ].map((agentArgs) => {
    const ownChoice = agentArgs?.includes('--effort')
    const options: Record<string, string> =
      agentArgs === undefined
        ? { model: 'opus', effort: 'high', permissionMode: 'ask' }
        : ownChoice
          ? { effort: 'high', permissionMode: 'ask' }
          : { permissionMode: 'ask' }
    return {
      global,
      repo: {
        ...(agentArgs !== undefined ? { agentArgs } : {}),
        ...(ownChoice
          ? {
              launchPreferences: {
                agentId: 'claude',
                options: { effort: 'high' },
                permissionMode: 'ask'
              }
            }
          : {})
      },
      raw: agentArgs ?? (agentArgs === undefined ? undefined : ''),
      options,
      applied: ownChoice ? { effort: 'high' } : options,
      command:
        agentArgs === undefined
          ? "claude '--debug' '--model' 'opus' '--effort' 'high' '--permission-mode' 'default'"
          : ownChoice
            ? "claude '--dangerously-skip-permissions' '--effort' 'high'"
            : `claude${agentArgs ? " '--verbose'" : ''} '--permission-mode' 'default'`
    }
  })
  for (const owned of [false, true]) {
    rows.push({
      global: {
        ...global,
        launchPreferences: { agentId: 'claude', model: 'opus', options: { effort: 'high' } }
      },
      repo: {
        agentArgs: '--model retired-unlisted-id --effort low',
        ...(owned
          ? { launchPreferences: { agentId: 'claude', model: 'opus', options: { effort: 'high' } } }
          : {})
      },
      raw: '--model retired-unlisted-id --effort low',
      options: owned ? { model: 'opus', effort: 'high' } : undefined,
      applied: owned ? { model: 'opus', effort: 'high' } : {},
      command: owned
        ? "claude '--model' 'opus' '--effort' 'high'"
        : "claude '--model' 'retired-unlisted-id' '--effort' 'low'"
    })
  }
  for (const repo of [
    { agentId: 'claude' as const },
    { launchPreferences: { agentId: 'codex' as const, permissionMode: 'ask' as const } }
  ]) {
    rows.push({
      global,
      repo,
      options: { model: 'opus', effort: 'high' },
      applied: { model: 'opus', effort: 'high' },
      command: "claude '--debug' '--model' 'opus' '--effort' 'high'"
    })
  }
  rows.push(
    {
      global,
      repo: {
        launchPreferences: {
          agentId: 'claude',
          modelSelection: {
            base: 'inherit',
            model: { agentId: 'claude', value: null },
            options: { effort: { agentId: 'claude', value: null } }
          }
        }
      },
      applied: {},
      command: "claude '--debug'"
    },
    {
      global: liftActionPermissionArgs({
        agentId: 'claude',
        agentArgs: '--model sonnet --effort high'
      }),
      repo: {
        launchPreferences: {
          agentId: 'claude',
          modelSelection: {
            base: 'inherit',
            model: { agentId: 'claude', value: null }
          }
        }
      },
      raw: '',
      options: { effort: 'high' },
      applied: { effort: 'high' },
      command: "claude '--effort' 'high'"
    },
    {
      global,
      repo: { launchPreferences: { agentId: 'claude', permissionMode: 'ask' } },
      options: { model: 'opus', effort: 'high', permissionMode: 'ask' },
      applied: { model: 'opus', effort: 'high', permissionMode: 'ask' },
      command: "claude '--debug' '--model' 'opus' '--effort' 'high' '--permission-mode' 'default'"
    },
    {
      global: liftActionPermissionArgs({
        agentId: 'claude',
        agentArgs: '--effort high',
        launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
      }),
      repo: { launchPreferences: { agentId: 'claude', model: 'sonnet' } },
      raw: '--effort high',
      options: { model: 'sonnet' },
      applied: { model: 'sonnet' },
      command: "claude '--effort' 'high' '--model' 'sonnet'"
    },
    {
      global: liftActionPermissionArgs({ agentId: 'codex', agentArgs: '-c model=o3' }),
      repo: { agentId: 'claude' },
      raw: '-c model=o3',
      applied: {},
      command: "claude '-c' 'model=o3'"
    },
    {
      global: liftActionPermissionArgs({ agentId: 'claude', agentArgs: '--model opus' }),
      repo: { agentId: 'claude-agent-teams' },
      agent: 'claude-agent-teams',
      raw: '--model opus',
      applied: {},
      command: "orca-ide claude-teams '--model' 'opus'"
    }
  )
  for (const agentId of [null, 'custom'] as const) {
    rows.push({
      global: liftActionPermissionArgs({ agentId: 'codex', agentArgs: '-m o3' }),
      repo: { agentId },
      defaultAgent: agentId === null ? 'blank' : 'claude',
      raw: '-m o3',
      applied: {},
      command: "claude '-m' 'o3'"
    })
  }
  for (const row of rows) {
    const settings = {
      agentPermissionDefault: 'own' as const,
      defaultTuiAgent: row.defaultAgent,
      sourceControlAi: { actions: { fixChecks: row.global } }
    }
    const repo = { id: 'repo', sourceControlAi: { actionOverrides: { fixChecks: row.repo } } }
    const ok = (result: unknown): RpcResponse => ({
      id: 'x',
      ok: true,
      result,
      _meta: { runtimeId: 'r' }
    })
    const sendRequest = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'settings.get') {
        return ok({ settings })
      }
      if (method === 'repo.list') {
        return ok({ repos: [repo] })
      }
      if (method === 'preflight.detectAgents') {
        return ok([row.agent ?? 'claude'])
      }
      if (method === 'agent.launchReplay') {
        return ok({
          outcome: { kind: 'terminal', handle: 'term' },
          worktreeId: 'repo::/w',
          receipt: {
            mode: 'terminal',
            preferred: 'terminal',
            reason: 'user_default',
            detail: 'Started a terminal agent.'
          },
          prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    expect(
      await launchAgentWithPrompt({
        client,
        hostCapabilities: [
          'agent.launch.v2',
          'agent.launch.replay.v1',
          'agent.launch.replay-required.v1',
          'agent.launch.chat-options.v1',
          'agent.launch.surface.v1'
        ],
        worktreeId: 'repo::/w',
        actionId: 'fixChecks',
        prompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).toEqual({ kind: 'sent' })
    const request = sendRequest.mock.calls.find(([method]) => method === 'agent.launchReplay')
    const params = AgentLaunchReplay.parse(request?.[1])
    expect(params.agent).toBe(row.agent ?? 'claude')
    if (row.raw === undefined) {
      expect(params).not.toHaveProperty('agentArgs')
    } else {
      expect(params.agentArgs).toBe(row.raw)
    }
    expect(params.chatOptions).toEqual(row.options)
    const launch = resolveAgentLaunchCommand({
      ...resolveAgentStartupPlanInputs({
        agent: params.agent,
        settings: { ...settings, agentDefaultArgs: { claude: '--debug' } },
        platform: 'linux',
        isRemote: false,
        shell: 'posix',
        agentArgs: params.agentArgs,
        sessionOptions: params.chatOptions
      }),
      shell: 'posix'
    })
    expect(launch.ok).toBe(true)
    if (!launch.ok) {
      throw new Error(launch.error)
    }
    expect(launch.command).toBe(row.command)
    expect(launch.appliedSessionOptions).toEqual(row.applied)
  }
})
