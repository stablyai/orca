import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../execution-host'
import { getPluginHostMethodSpec } from './plugin-host-api'
import { agentStatusChangedPayloadSchema } from './plugin-events'
import {
  PLUGIN_AGENT_MODEL_MAX_LENGTH,
  PLUGIN_AGENT_PROFILE_MAX_LENGTH,
  PLUGIN_AGENT_TYPE_MAX_LENGTH,
  projectPluginAgentContext,
  projectPluginExecutionHost,
  selectPluginAgentLabels
} from './plugin-workspace-read-context'

describe('projectPluginExecutionHost', () => {
  it('labels a local host without using os.hostname', () => {
    expect(projectPluginExecutionHost('local')).toEqual({
      kind: 'local',
      label: getLocalExecutionHostLabel()
    })
  })

  it('uses the SSH target display label, not a DNS hostname', () => {
    expect(
      projectPluginExecutionHost('ssh:build-box', {
        hostLabelById: new Map([['ssh:build-box', 'Build box']])
      })
    ).toEqual({ kind: 'ssh', label: 'Build box' })
  })

  it('falls back to the SSH target id when no override exists', () => {
    expect(projectPluginExecutionHost('ssh:build-box')).toEqual({
      kind: 'ssh',
      label: 'build-box'
    })
  })

  it('labels a runtime environment without leaking a host id field', () => {
    const projected = projectPluginExecutionHost('runtime:env-1')
    expect(projected).toEqual({ kind: 'runtime', label: 'env-1' })
    expect(projected).not.toHaveProperty('id')
    expect(projected).not.toHaveProperty('hostId')
  })

  it('returns null when the host id is missing or unparseable', () => {
    expect(projectPluginExecutionHost(null)).toBeNull()
    expect(projectPluginExecutionHost(undefined)).toBeNull()
    expect(projectPluginExecutionHost('satellite')).toBeNull()
  })
})

describe('projectPluginAgentContext', () => {
  it('omits the object when every label is empty', () => {
    expect(projectPluginAgentContext({})).toBeNull()
    expect(projectPluginAgentContext({ type: '  ', model: null, profile: undefined })).toBeNull()
  })

  it('keeps known labels and nulls the rest', () => {
    expect(
      projectPluginAgentContext({ type: 'claude', model: 'opus-4', profile: 'Personal' })
    ).toEqual({
      type: 'claude',
      model: 'opus-4',
      profile: 'Personal'
    })
  })

  it('clamps labels to the plugin bounds', () => {
    const projected = projectPluginAgentContext({
      type: 'c'.repeat(PLUGIN_AGENT_TYPE_MAX_LENGTH + 8),
      model: 'm'.repeat(PLUGIN_AGENT_MODEL_MAX_LENGTH + 8),
      profile: 'p'.repeat(PLUGIN_AGENT_PROFILE_MAX_LENGTH + 8)
    })
    expect(projected?.type).toHaveLength(PLUGIN_AGENT_TYPE_MAX_LENGTH)
    expect(projected?.model).toHaveLength(PLUGIN_AGENT_MODEL_MAX_LENGTH)
    expect(projected?.profile).toHaveLength(PLUGIN_AGENT_PROFILE_MAX_LENGTH)
  })
})

describe('selectPluginAgentLabels', () => {
  it('prefers the newest non-done status on the focused worktree', () => {
    expect(
      selectPluginAgentLabels(
        [
          {
            worktreeId: 'wt-a',
            state: 'done',
            agentType: 'codex',
            model: 'old',
            receivedAt: 300
          },
          {
            worktreeId: 'wt-a',
            state: 'working',
            agentType: 'claude',
            model: 'opus-4',
            receivedAt: 200
          },
          {
            worktreeId: 'wt-b',
            state: 'working',
            agentType: 'gemini',
            model: 'other-host',
            receivedAt: 400
          }
        ],
        'wt-a'
      )
    ).toEqual({ type: 'claude', model: 'opus-4' })
  })

  it('falls back to createdWithAgent when no live labels exist', () => {
    expect(selectPluginAgentLabels([], 'wt-a', 'codex')).toEqual({
      type: 'codex',
      model: null
    })
  })

  it('does not invent labels for another worktree', () => {
    expect(
      selectPluginAgentLabels(
        [{ worktreeId: 'wt-b', state: 'working', agentType: 'claude', receivedAt: 1 }],
        'wt-a'
      )
    ).toEqual({ type: null, model: null })
  })
})

describe('workspace.readContext result schema', () => {
  const result = getPluginHostMethodSpec('workspace.readContext')!.result

  it('accepts the v0 three-field shape so old plugins keep working', () => {
    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one' }]
      }).success
    ).toBe(true)
  })

  it('accepts additive executionHost and agent labels', () => {
    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [],
        executionHost: { kind: 'ssh', label: 'Build box' },
        agent: { type: 'claude', model: 'opus-4', profile: 'Personal' }
      }).success
    ).toBe(true)
  })

  it('accepts focusedSurface join keys without a path field', () => {
    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [],
        focusedSurface: {
          kind: 'agent',
          title: 'Claude',
          worktreeId: 'pj_1',
          agentId: 'tab-agent-1'
        }
      }).success
    ).toBe(true)
    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [],
        focusedSurface: {
          kind: 'agent',
          title: 'Claude',
          path: '/Users/private/orca'
        }
      }).success
    ).toBe(false)
  })

  it('rejects a hostname-shaped extra field on executionHost', () => {
    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [],
        executionHost: { kind: 'ssh', label: 'Build box', hostname: 'box.internal' }
      }).success
    ).toBe(false)
  })
})

describe('agent.status.changed payload schema', () => {
  it('accepts the v0 payload without agent labels', () => {
    expect(
      agentStatusChangedPayloadSchema.safeParse({
        worktreeId: null,
        paneKey: 'tab:leaf',
        state: 'working',
        receivedAt: 1
      }).success
    ).toBe(true)
  })

  it('accepts an additive agent object', () => {
    expect(
      agentStatusChangedPayloadSchema.safeParse({
        worktreeId: 'wt-a',
        paneKey: 'tab:leaf',
        state: 'working',
        receivedAt: 1,
        agent: { type: 'claude', model: null, profile: 'Personal' }
      }).success
    ).toBe(true)
  })
})
