import { describe, expect, it } from 'vitest'
import {
  MaestroBootstrapReceiptSchema,
  MaestroBootstrapRequestSchema
} from './maestro-bootstrap-contract'

const mutation = {
  mutation_id: 'mutation-1',
  execution_host_id: 'host-local',
  workspace_key: 'folder:repo-1',
  run_id: 'run-1'
} as const

const workspaceScope = {
  schema_version: 1,
  repository_id: 'repo-1',
  canonical_root: '/repo',
  execution_host: { id: 'host-local', boundary: 'local' },
  orchestration_home: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:repo-1',
    kind: 'folder',
    path: '/repo'
  },
  execution_workspace: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:repo-1',
    kind: 'folder',
    path: '/repo'
  },
  base_revision: 'folder-observation:opaque-1',
  dirty_paths: [],
  run_id: 'run-1',
  coordinator_generation: 3,
  binding_receipt_ref: 'artifact:receipts/workspace.json',
  binding_receipt_hash: `sha256:${'c'.repeat(64)}`
} as const

describe('Maestro composed bootstrap contract', () => {
  it('accepts a bounded strict bootstrap request', () => {
    const request = {
      schema_version: 1,
      protocol: 'maestro-bootstrap/v1',
      mutation,
      coordinator_generation: 3
    }
    expect(MaestroBootstrapRequestSchema.parse(request)).toEqual(request)
    expect(MaestroBootstrapRequestSchema.safeParse({ ...request, payload: {} }).success).toBe(false)
  })

  it('accepts published and replayed revision-zero receipts', () => {
    for (const outcome of ['published', 'replayed'] as const) {
      expect(
        MaestroBootstrapReceiptSchema.safeParse({
          schema_version: 1,
          protocol: 'maestro-bootstrap-receipt/v1',
          mutation,
          coordinator_generation: 3,
          workspace_scope: workspaceScope,
          projection_revision: 0,
          outcome
        }).success
      ).toBe(true)
    }
  })

  it('rejects cross-workspace, cross-run, and stale-generation receipts', () => {
    const receipt = {
      schema_version: 1,
      protocol: 'maestro-bootstrap-receipt/v1',
      mutation,
      coordinator_generation: 3,
      workspace_scope: workspaceScope,
      projection_revision: 0,
      outcome: 'published'
    }
    expect(
      MaestroBootstrapReceiptSchema.safeParse({
        ...receipt,
        mutation: { ...mutation, workspace_key: 'folder:other' }
      }).success
    ).toBe(false)
    expect(
      MaestroBootstrapReceiptSchema.safeParse({
        ...receipt,
        mutation: { ...mutation, run_id: 'run-other' }
      }).success
    ).toBe(false)
    expect(
      MaestroBootstrapReceiptSchema.safeParse({ ...receipt, coordinator_generation: 2 }).success
    ).toBe(false)
  })

  it('rejects unbounded mutation identities', () => {
    expect(
      MaestroBootstrapRequestSchema.safeParse({
        schema_version: 1,
        protocol: 'maestro-bootstrap/v1',
        mutation: { ...mutation, mutation_id: 'x'.repeat(513) },
        coordinator_generation: 3
      }).success
    ).toBe(false)
  })
})
