import { describe, expect, it } from 'vitest'
import {
  WorkspaceSurfaceSnapshotSchema,
  workspaceSurfaceKey,
  type WorkspaceSurfaceId
} from './maestro-workspace-canvas'

const surfaceId: WorkspaceSurfaceId = {
  execution_host_id: 'ssh-host-1',
  workspace_key: 'folder:workspace-1',
  unified_tab_id: 'tab-1'
}
const surfaceKey = workspaceSurfaceKey(surfaceId)

function snapshot() {
  return {
    schema_version: 1,
    protocol: 'workspace-surface-snapshot/v1',
    execution_host_id: 'ssh-host-1',
    workspace_key: 'folder:workspace-1',
    authority_revision: 7,
    authority_cursor: 'cursor-7',
    state: 'ready',
    surfaces: {
      [surfaceKey]: {
        id: surfaceId,
        content_type: 'terminal',
        entity_id: 'terminal-1',
        group_id: 'group-1',
        title: 'Worker',
        revision: 3,
        availability: 'available',
        binding: {
          kind: 'terminal',
          terminal_tab_id: 'terminal-1',
          pane_key: 'pane-1',
          session_id: 'session-1',
          pty_incarnation: 'incarnation-1',
          liveness: 'live',
          authority_revision: 3
        }
      }
    },
    unsupported: [],
    automatic_links: [],
    suggested_links: [],
    capability: { available: true, reason: null },
    harness_overlay: null
  }
}

describe('WorkspaceSurfaceSnapshot v1', () => {
  it('keys a surface by its exact host, workspace, and unified tab identity', () => {
    const parsed = WorkspaceSurfaceSnapshotSchema.parse(snapshot())
    expect(parsed.surfaces[surfaceKey]?.binding).toMatchObject({
      kind: 'terminal',
      pane_key: 'pane-1',
      pty_incarnation: 'incarnation-1'
    })
  })

  it('rejects aliases and mismatched domain authority', () => {
    const value = snapshot()
    value.surfaces = {
      'terminal-1': {
        ...value.surfaces[surfaceKey],
        content_type: 'browser',
        binding: value.surfaces[surfaceKey].binding
      }
    }
    expect(() => WorkspaceSurfaceSnapshotSchema.parse(value)).toThrow()
  })

  it('requires inspectable authority for automatic links', () => {
    const secondId = { ...surfaceId, unified_tab_id: 'tab-2' }
    const secondKey = workspaceSurfaceKey(secondId)
    const value = snapshot()
    value.surfaces[secondKey] = { ...value.surfaces[surfaceKey], id: secondId }
    Object.assign(value, {
      automatic_links: [
        {
          id: 'link-1',
          source_surface_key: surfaceKey,
          target_surface_key: secondKey,
          link_type: 'executes',
          authority_kind: 'execution-receipt',
          authority_id: 'receipt-1',
          authority_revision: 4,
          observed_at: '2026-08-25T12:00:00.000Z',
          explanation_code: 'executes-resource'
        }
      ]
    })
    expect(WorkspaceSurfaceSnapshotSchema.parse(value).automatic_links[0]).toMatchObject({
      authority_kind: 'execution-receipt',
      authority_id: 'receipt-1'
    })
    const withoutProvenance = structuredClone(value) as Record<string, unknown>
    delete (withoutProvenance.automatic_links as Record<string, unknown>[])[0]?.authority_id
    expect(() => WorkspaceSurfaceSnapshotSchema.parse(withoutProvenance)).toThrow()
  })
})
