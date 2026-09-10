import { describe, expect, it } from 'vitest'
import { emptyWorkspaceCanvasDocument } from '../../../shared/maestro-workspace-document-state'
import type { RuntimeMaestroWorkspaceCanvasQueryResult } from '../../../shared/runtime-types'
import {
  INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
  reconcileMaestroWorkspaceCanvasMutation,
  reconcileMaestroWorkspaceCanvasQuery
} from './maestro-workspace-reconciliation'

function available(revision: number): RuntimeMaestroWorkspaceCanvasQueryResult {
  return {
    status: 'available',
    actor_id: 'actor-1',
    snapshot: {
      schema_version: 1,
      protocol: 'workspace-surface-snapshot/v1',
      execution_host_id: 'local',
      workspace_key: 'folder:workspace-1',
      authority_revision: revision,
      authority_cursor: `cursor-${revision}`,
      state: 'ready',
      surfaces: {},
      unsupported: [],
      automatic_links: [],
      suggested_links: [],
      capability: { available: true, reason: null },
      harness_overlay: null
    },
    canvas: { revision, document: emptyWorkspaceCanvasDocument(), updated_at: null }
  }
}

describe('workspace Canvas reconciliation', () => {
  it('reuses an unchanged authoritative snapshot', () => {
    const current = reconcileMaestroWorkspaceCanvasQuery(
      INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
      available(4)
    )

    expect(reconcileMaestroWorkspaceCanvasQuery(current, available(4))).toBe(current)
  })

  it('ignores an older authoritative snapshot', () => {
    const current = reconcileMaestroWorkspaceCanvasQuery(
      INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
      available(4)
    )
    expect(reconcileMaestroWorkspaceCanvasQuery(current, available(3))).toBe(current)
  })

  it('retains last-known surfaces when authority becomes unavailable', () => {
    const current = reconcileMaestroWorkspaceCanvasQuery(
      INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
      available(4)
    )
    const next = reconcileMaestroWorkspaceCanvasQuery(current, {
      status: 'unavailable',
      reason: 'authority-unreachable',
      liveness: 'unverifiable'
    })
    expect(next.status).toBe('unavailable')
    expect(next.result?.snapshot.authority_revision).toBe(4)
  })

  it('preserves the Canvas after a cancelled or unknown mutation', () => {
    const current = reconcileMaestroWorkspaceCanvasQuery(
      INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
      available(4)
    )
    for (const status of ['cancelled', 'outcome_unknown'] as const) {
      const next = reconcileMaestroWorkspaceCanvasMutation(current, {
        status,
        authority_revision: 4
      })
      expect(next.result).toBe(current.result)
      expect(next.mutation?.status).toBe(status)
    }
  })
})
