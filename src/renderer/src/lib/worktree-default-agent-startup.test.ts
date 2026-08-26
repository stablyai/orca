import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  buildDefaultAgentStartupPayload,
  resolveEmptyWorktreeDefaultAgent
} from '@/lib/default-agent-startup-payload'

describe('resolveEmptyWorktreeDefaultAgent', () => {
  it('uses a pinned default even when it is not in the detected list', () => {
    expect(
      resolveEmptyWorktreeDefaultAgent({
        settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
        detectedAgentIds: ['claude']
      })
    ).toBe('codex')
  })

  it('does not launch when the default is a blank terminal', () => {
    expect(
      resolveEmptyWorktreeDefaultAgent({
        settings: { defaultTuiAgent: 'blank', disabledTuiAgents: [] },
        detectedAgentIds: ['claude', 'codex']
      })
    ).toBeNull()
  })

  it('does not launch a disabled pinned default', () => {
    expect(
      resolveEmptyWorktreeDefaultAgent({
        settings: { defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] },
        detectedAgentIds: ['claude', 'codex']
      })
    ).toBeNull()
  })

  it('auto-picks from detected agents when no default is set', () => {
    expect(
      resolveEmptyWorktreeDefaultAgent({
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        detectedAgentIds: ['codex', 'claude']
      })
    ).toBe('claude')
  })

  it('does not infer an agent when auto mode has no detections yet', () => {
    expect(
      resolveEmptyWorktreeDefaultAgent({
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        detectedAgentIds: null
      })
    ).toBeNull()
  })
})

describe('buildDefaultAgentStartupPayload', () => {
  it('queues the pinned agent with sidebar telemetry', () => {
    const startup = buildDefaultAgentStartupPayload({
      agent: 'codex',
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex'
      },
      launchSource: 'sidebar',
      platform: 'darwin'
    })

    expect(startup).toEqual({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'sidebar',
        request_kind: 'new'
      }
    })
  })
})
