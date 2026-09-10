import { describe, expect, it } from 'vitest'
import {
  MaestroBrowserSurfaceReceiptSchema,
  MaestroBrowserSurfaceActionRequestSchema,
  MaestroBrowserSurfaceRequestSchema
} from './maestro-browser-surface'
import { AgentGraphViewSchema } from './maestro-contract'

const hash = `sha256:${'a'.repeat(64)}`

export function browserSurfaceReceipt() {
  return MaestroBrowserSurfaceReceiptSchema.parse({
    schema_version: 1,
    protocol: 'maestro-browser-surface/v1',
    surface_id: 'browser-surface-request-1',
    request_id: 'request-1',
    run_id: 'run-1',
    task_id: 'ORC-07B',
    attempt_id: 'attempt-orc-07b-001',
    agent_id: 'agent-1',
    owner_principal: 'coordinator-1',
    ownership: 'harness',
    execution_host_id: 'local',
    workspace_key: 'folder:workspace-1',
    browser_page_id: 'maestro-request-1',
    title: 'Browser validation',
    url: 'https://example.com/validation',
    origin: 'https://example.com',
    profile_id: null,
    requested_visibility: 'visible',
    observed_visibility: 'visible',
    viewport: { width: 1920, height: 1080, device_scale_factor: 1 },
    retention: 'release_when_settled',
    state: 'active',
    focus_receipt: {
      requested: true,
      workspace_activated: true,
      exact_page_selected: true,
      native_pane_paint: 'painted',
      observed_at: '2026-08-24T12:00:00.000Z',
      unavailable_reason: null
    },
    evidence: {
      route_or_component: 'Maestro browser surface',
      state: 'visible validation attached light',
      theme: 'light',
      source_revision: 'revision-1',
      capture_mode: 'native-viewport'
    },
    evidence_receipt: {
      protocol: 'maestro-browser-evidence/v1',
      artifact_ref: 'artifact:maestro-browser-evidence/sha256/capture.png',
      artifact_hash: hash,
      format: 'png',
      dimensions: { width: 1920, height: 1080, device_scale_factor: 1 },
      route_or_component: 'Maestro browser surface',
      state: 'visible validation attached light',
      theme: 'light',
      source_revision: 'revision-1',
      capture_mode: 'native-viewport',
      captured_at: '2026-08-24T12:00:00.000Z',
      vision_review: { outcome: 'pass', reviewer: 'vision-reviewer', observation: 'No clipping.' }
    },
    release_receipt: {
      requested: false,
      outcome: 'not_requested',
      exact_page_closed: false,
      profile_affected: false,
      observed_at: null,
      reason: null
    },
    created_at: '2026-08-24T12:00:00.000Z',
    updated_at: '2026-08-24T12:00:00.000Z'
  })
}

describe('Maestro browser surface contract', () => {
  it('accepts exact visible and offscreen requests', () => {
    const request = {
      schema_version: 1,
      protocol: 'maestro-browser-surface/v1',
      request_id: 'request-1',
      workspace: {
        repository_id: 'repo-1',
        execution_host_id: 'local',
        workspace_key: 'folder:workspace-1',
        run_id: 'run-1'
      },
      actor: {
        actor_id: 'coordinator-1',
        kind: 'coordinator',
        authenticated: true,
        session_id: 'session-1'
      },
      coordinator_generation: 1,
      task_id: 'ORC-07B',
      attempt_id: 'attempt-orc-07b-001',
      agent_id: 'agent-1',
      url: 'https://example.com/validation',
      title: 'Browser validation',
      profile_id: null,
      requested_visibility: 'visible',
      viewport: { width: 1920, height: 1080, device_scale_factor: 1 },
      retention: 'release_when_settled',
      ownership: 'harness',
      evidence: {
        route_or_component: 'Maestro browser surface',
        state: 'visible validation attached light',
        theme: 'light',
        source_revision: 'revision-1',
        capture_mode: 'native-viewport'
      }
    }
    expect(MaestroBrowserSurfaceRequestSchema.parse(request).requested_visibility).toBe('visible')
    expect(
      MaestroBrowserSurfaceRequestSchema.parse({ ...request, requested_visibility: 'offscreen' })
        .requested_visibility
    ).toBe('offscreen')
  })

  it('requires an exact bound surface action', () => {
    expect(
      MaestroBrowserSurfaceActionRequestSchema.parse({
        schema_version: 1,
        protocol: 'maestro-browser-surface/v1',
        workspace: {
          repository_id: 'repo-1',
          execution_host_id: 'local',
          workspace_key: 'folder:workspace-1',
          run_id: 'run-1'
        },
        actor: {
          actor_id: 'coordinator-1',
          kind: 'coordinator',
          authenticated: true,
          session_id: 'session-1'
        },
        coordinator_generation: 1,
        surface_id: 'browser-surface-request-1'
      })
    ).toMatchObject({ surface_id: 'browser-surface-request-1' })
  })

  it('rejects browser graph resources that carry secrets or image bytes', () => {
    const receipt = browserSurfaceReceipt()
    const base = {
      schema_version: 1,
      protocol: 'agent-graph-view/v1',
      kind: 'snapshot',
      workspace_scope: {
        schema_version: 1,
        repository_id: 'repo-1',
        canonical_root: '/workspace',
        execution_host: { id: 'local', boundary: 'local' },
        orchestration_home: {
          execution_host_id: 'local',
          workspace_key: 'folder:workspace-1',
          kind: 'folder',
          path: '/workspace'
        },
        execution_workspace: {
          execution_host_id: 'local',
          workspace_key: 'folder:workspace-1',
          kind: 'folder',
          path: '/workspace'
        },
        base_revision: 'revision-1',
        dirty_paths: [],
        run_id: 'run-1',
        coordinator_generation: 1,
        binding_receipt_ref: 'artifact:workspace.json',
        binding_receipt_hash: hash
      },
      change: 'change-1',
      run_id: 'run-1',
      coordinator: { id: 'coordinator-1', generation: 1 },
      capabilities: { agents: [], efforts: [], placement_kinds: [], watch_deltas: false },
      nodes: [
        {
          id: 'browser-1',
          type: 'browser-surface',
          status: 'active',
          summary: 'Browser',
          resource: receipt
        }
      ],
      edges: [],
      removed_node_ids: [],
      removed_edge_ids: [],
      revision: 1,
      cursor: null,
      from_cursor: null,
      reset_required: false
    }
    expect(AgentGraphViewSchema.safeParse(base).success).toBe(true)
    expect(
      AgentGraphViewSchema.safeParse({
        ...base,
        nodes: [{ ...base.nodes[0], resource: { ...receipt, cookies: ['secret'] } }]
      }).success
    ).toBe(false)
    expect(
      AgentGraphViewSchema.safeParse({
        ...base,
        nodes: [{ ...base.nodes[0], resource: { ...receipt, image_bytes: 'base64' } }]
      }).success
    ).toBe(false)
  })
})
