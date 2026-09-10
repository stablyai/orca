import { describe, expect, it } from 'vitest'
import {
  MaestroDelegationRequestSchema,
  parseMaestroDelegationRequest,
  resolveMaestroDelegationProfile
} from './maestro-delegation'
import { buildMaestroDelegationCatalog } from './maestro-delegation-catalog'

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'folder:folder-1',
  run_id: 'run-1'
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    protocol: 'maestro-delegation/v1',
    intent_id: 'intent-1',
    workspace,
    source: { kind: 'canvas-point', position: { x: 10, y: 20 } },
    parent_task_id: null,
    parent_attempt_id: null,
    purpose: 'Review the bounded change',
    role: 'review',
    requested: { lane: 'balanced', agent: null, model: null, effort: null },
    placement_request: { kind: 'current-workspace' },
    context_refs: [],
    paths: ['src/shared/maestro-delegation.ts'],
    check: 'pnpm test',
    ...overrides
  }
}

describe('Maestro delegation contract', () => {
  it('parses task, attempt, note, and empty Canvas sources without caller authority fields', () => {
    const parsed = parseMaestroDelegationRequest(
      request({
        source: { kind: 'note', note_id: 'note-1', revision: 'note-2' },
        parent_task_id: 'task-1',
        parent_attempt_id: 'attempt-1'
      })
    )
    expect(parsed.source).toEqual({ kind: 'note', note_id: 'note-1', revision: 'note-2' })
    expect('actor' in parsed).toBe(false)
    expect('coordinator_generation' in parsed).toBe(false)
  })

  it('rejects forged server-owned fields and invalid workspace identities', () => {
    expect(() =>
      MaestroDelegationRequestSchema.parse(request({ actor: { kind: 'system' } }))
    ).toThrow()
    expect(() =>
      MaestroDelegationRequestSchema.parse(
        request({ workspace: { ...workspace, workspace_key: 'not-a-key' } })
      )
    ).toThrow()
  })

  it('keeps requested choices while resolving only catalog-supported values', () => {
    const resolved = resolveMaestroDelegationProfile({
      requested: { lane: 'balanced', agent: 'codex', model: 'not-a-model', effort: 'high' },
      placement: {
        kind: 'create-child-worktree',
        execution_host_id: 'local',
        parent_workspace_key: 'folder:folder-1',
        name_hint: 'child'
      },
      permissionMode: 'yolo'
    })
    expect(resolved).toMatchObject({
      agent: 'codex',
      model: null,
      effort: null,
      permission_mode: 'yolo'
    })
    expect(resolved.placement).toMatchObject({
      kind: 'create-child-worktree',
      parent_workspace_key: 'folder:folder-1'
    })
  })

  it('uses configured launch settings and fails closed for current workspace', () => {
    const catalog = buildMaestroDelegationCatalog({
      agents: ['codex'],
      settings: {
        disabledTuiAgents: [],
        agentDefaultArgs: { codex: '--yolo' },
        agentDefaultEnv: {}
      },
      placements: []
    })
    expect(catalog.agents[0]?.permission_mode).toBe('yolo')
    expect(() =>
      resolveMaestroDelegationProfile({
        requested: { lane: 'balanced', agent: null, model: null, effort: null },
        placement: { kind: 'current-workspace' },
        permissionMode: 'manual'
      })
    ).toThrow('current_workspace_unavailable')
  })
})
