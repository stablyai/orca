import { describe, expect, it } from 'vitest'
import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type {
  WorkspaceAutomaticLink,
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'
import type { CanvasAgentTopology } from './maestro-agent-topology'
import { buildMaestroWorkspaceTopologyLayoutNodes } from './maestro-workspace-topology-layout-input'

const document: WorkspaceCanvasDocument = {
  schema_version: 1,
  last_surface_revision: 0,
  placements: {},
  annotations: {},
  manual_links: [],
  suggestion_decisions: {},
  ui_preferences: { inspector_open: false, inspector_width: 320 }
}

function terminal(id: string): WorkspaceSurface {
  return {
    id: {
      execution_host_id: 'local',
      workspace_key: 'folder:workspace',
      unified_tab_id: id
    },
    content_type: 'terminal',
    entity_id: id,
    group_id: 'group',
    title: id,
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: id,
      pane_key: id,
      session_id: `pty-${id}`,
      pty_incarnation: '1',
      liveness: 'live',
      authority_revision: 1
    }
  }
}

function browser(id: string): WorkspaceSurface {
  return {
    id: {
      execution_host_id: 'local',
      workspace_key: 'folder:workspace',
      unified_tab_id: id
    },
    content_type: 'browser',
    entity_id: id,
    group_id: 'group',
    title: id,
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'browser',
      browser_workspace_id: 'browser-workspace',
      browser_page_id: id,
      profile_id: null,
      partition_id: null,
      authority_revision: 1,
      live_frame: null,
      immutable_capture: null
    }
  }
}

function automaticLink(id: string, source: string, target: string): WorkspaceAutomaticLink {
  return {
    id,
    source_surface_key: source,
    target_surface_key: target,
    link_type: 'executes',
    authority_kind: 'execution-receipt',
    authority_id: id,
    authority_revision: 1,
    observed_at: '2026-08-27T12:00:00.000Z',
    explanation_code: 'executes-resource'
  }
}

function snapshot(automaticLinks: WorkspaceAutomaticLink[]): WorkspaceSurfaceSnapshot {
  return {
    schema_version: 1,
    protocol: 'workspace-surface-snapshot/v1',
    execution_host_id: 'local',
    workspace_key: 'folder:workspace',
    authority_revision: 1,
    authority_cursor: 'cursor-1',
    state: 'ready',
    surfaces: {
      coordinator: terminal('coordinator'),
      worker: terminal('worker'),
      independent: terminal('independent'),
      browser: browser('browser')
    },
    unsupported: [],
    automatic_links: automaticLinks,
    suggested_links: [],
    capability: { available: true, reason: null },
    harness_overlay: null
  }
}

const topology: CanvasAgentTopology = {
  coordinatorSurfaceId: 'coordinator',
  nodes: [
    {
      surfaceId: 'coordinator',
      paneKey: 'coordinator:coordinator',
      coordinatorSurfaceId: 'coordinator',
      functionLabel: 'Orchestrator',
      provenance: 'runtime-lineage'
    },
    {
      surfaceId: 'worker',
      paneKey: 'worker:worker',
      parentSurfaceId: 'coordinator',
      coordinatorSurfaceId: 'coordinator',
      functionLabel: 'Verification',
      provenance: 'runtime-lineage'
    }
  ],
  relations: []
}

describe('Maestro topology layout input', () => {
  it('maps exact agent lineage and resource ownership into layout nodes', () => {
    const nodes = buildMaestroWorkspaceTopologyLayoutNodes({
      snapshot: snapshot([automaticLink('browser-owner', 'worker', 'browser')]),
      document,
      surfaceKeys: ['browser', 'coordinator', 'independent', 'worker'],
      topology
    })

    expect(nodes.find((node) => node.surfaceKey === 'coordinator')).toMatchObject({
      isCoordinator: true,
      functionLabel: 'Orchestrator'
    })
    expect(nodes.find((node) => node.surfaceKey === 'worker')).toMatchObject({
      parentSurfaceKey: 'coordinator',
      functionLabel: 'Verification'
    })
    expect(nodes.find((node) => node.surfaceKey === 'browser')).toMatchObject({
      ownerSurfaceKey: 'worker'
    })
    expect(nodes.find((node) => node.surfaceKey === 'independent')).toMatchObject({
      parentSurfaceKey: undefined,
      functionLabel: undefined,
      isCoordinator: false
    })
  })

  it('omits an ambiguous resource owner instead of guessing', () => {
    const nodes = buildMaestroWorkspaceTopologyLayoutNodes({
      snapshot: snapshot([
        automaticLink('first-owner', 'coordinator', 'browser'),
        automaticLink('second-owner', 'worker', 'browser')
      ]),
      document,
      surfaceKeys: ['browser', 'coordinator', 'worker'],
      topology
    })

    expect(nodes.find((node) => node.surfaceKey === 'browser')?.ownerSurfaceKey).toBeUndefined()
  })
})
