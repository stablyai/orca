import { describe, expect, it } from 'vitest'
import type { WorktreeStartupLaunch } from '../../../../../../shared/worktree/launch-types'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateRequest
} from './worktree-create-payload'

const ATTEMPT = { name: 'agent-startup' }
const LAUNCH_CONFIG = {
  agentCommand: "codex '--model' 'gpt-5'",
  agentArgs: '--model gpt-5',
  agentEnv: { A: '1' }
}
const TELEMETRY = {
  agent_kind: 'codex',
  launch_source: 'new_workspace_composer',
  request_kind: 'new'
} as const

// The quick composer's backendStartup shapes (quick-startup-plan.ts); viewMode comes from
// resolveBackendDraftStartup for a native-prefill draft.
const STARTUPS: { name: string; startup: WorktreeStartupLaunch; expectedStartupFields: object }[] =
  [
    {
      name: 'Codex auto-submit with env and shell-ready delivery',
      startup: {
        command: "codex '--model' 'gpt-5' 'fix it'",
        env: { A: '1' },
        launchConfig: LAUNCH_CONFIG,
        launchAgent: 'codex',
        startupCommandDelivery: 'shell-ready',
        telemetry: TELEMETRY
      },
      expectedStartupFields: {
        startupCommand: "codex '--model' 'gpt-5' 'fix it'",
        startupEnv: { A: '1' },
        startupLaunchConfig: LAUNCH_CONFIG,
        startupCommandDelivery: 'shell-ready',
        activate: true
      }
    },
    {
      name: 'Claude native-prefill draft with viewMode',
      startup: {
        command: `claude --prefill 'review Bob'"'"'s change'`,
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        launchAgent: 'claude',
        viewMode: 'terminal',
        telemetry: { ...TELEMETRY, agent_kind: 'claude-code' }
      },
      expectedStartupFields: {
        startupCommand: `claude --prefill 'review Bob'"'"'s change'`,
        startupLaunchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        activate: true
      }
    }
  ]

function makeRequest(startup: WorktreeStartupLaunch | undefined): WorktreeCreateRequest {
  return {
    repoId: 'repo1',
    name: 'agent-startup',
    baseBranch: 'origin/main',
    setupDecision: 'skip',
    telemetrySource: 'sidebar',
    createdWithAgent: 'codex',
    creationId: 'creation-1',
    ...(startup ? { startup } : {})
  }
}

// Pins main's current launch behaviour as the convergence parity baseline (row 8, quick composer
// paired/local create): the window-built startup is sent for verbatim execution, never as intent.
describe('row 8: worktree create payload startup on main', () => {
  // The worktrees-remote-runtime-create.test.ts pins use objectContaining, so key drops are unpinned there.
  it.each(STARTUPS)(
    'paired runtime: $name maps to startup* fields and drops telemetry, launchAgent, viewMode',
    ({ startup, expectedStartupFields }) => {
      expect(buildRuntimeWorktreeCreateParams(makeRequest(startup), ATTEMPT)).toStrictEqual({
        repo: 'repo1',
        name: 'agent-startup',
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        sparseCheckout: undefined,
        telemetrySource: 'sidebar',
        createdWithAgent: 'codex',
        // main today: creationId never crosses to the paired host.
        ...expectedStartupFields
      })
    }
  )

  it('paired runtime: a draft without startup sends startupDraft and no activate', () => {
    const request = { ...makeRequest(undefined), options: { startupDraft: 'Fix issue 12' } }

    expect(buildRuntimeWorktreeCreateParams(request, ATTEMPT)).toStrictEqual({
      repo: 'repo1',
      name: 'agent-startup',
      baseBranch: 'origin/main',
      setupDecision: 'skip',
      sparseCheckout: undefined,
      telemetrySource: 'sidebar',
      createdWithAgent: 'codex',
      startupDraft: 'Fix issue 12'
    })
  })

  it.each(STARTUPS)('local IPC: $name passes the startup object as-is', ({ startup }) => {
    const request = makeRequest(startup)
    const args = buildLocalWorktreeCreateArgs(request, ATTEMPT)

    expect(args).toStrictEqual({
      repoId: 'repo1',
      name: 'agent-startup',
      baseBranch: 'origin/main',
      setupDecision: 'skip',
      sparseCheckout: undefined,
      telemetrySource: 'sidebar',
      createdWithAgent: 'codex',
      startup,
      creationId: 'creation-1'
    })
    expect(args.startup).toBe(startup)
  })
})
