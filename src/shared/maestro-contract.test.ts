import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MaestroContextSnapshotSchema,
  parseAgentGraphView,
  MaestroDocumentSchema,
  parseDelegationIntent,
  parseMaestroDocumentLayoutMutation,
  parseMaestroDocumentAuthoringMutation,
  parseMaestroDocumentReadScope,
  parseMaestroMutation
} from './maestro-contract'

const fixtures = resolve(process.cwd(), 'tests/fixtures/maestro-protocol-v1')

describe('Maestro protocol v1', () => {
  it('keeps public context snapshots metadata-only', () => {
    expect(
      MaestroContextSnapshotSchema.safeParse({
        note_id: 'note-1',
        revision: 'note-1',
        content_hash: `sha256:${'a'.repeat(64)}`,
        media_type: 'text/markdown',
        title: 'Note',
        snapshot_path: 'maestro/context/note-1/1.md',
        byte_count: 4,
        content: 'body'
      }).success
    ).toBe(false)
  })

  it('accepts only bounded pair-scoped layout mutations', () => {
    const mutation = parseMaestroDocumentLayoutMutation({
      schema_version: 1,
      protocol: 'maestro-document-layout-mutation/v1',
      mutation_id: 'layout-1',
      scope: { execution_host_id: 'local', workspace_key: 'folder:folder-1' },
      expected_revision: 0,
      operation: { kind: 'set-viewport', viewport: { center: { x: 10, y: 20 }, zoom: 1 } }
    })
    expect(mutation.operation.kind).toBe('set-viewport')
    expect(() =>
      parseMaestroDocumentLayoutMutation({
        schema_version: 1,
        protocol: 'maestro-document-layout-mutation/v1',
        mutation_id: 'layout-2',
        scope: { execution_host_id: 'local', workspace_key: 'folder:folder-1' },
        expected_revision: 0,
        actor: { actor_id: 'forged', kind: 'system', authenticated: true, session_id: 'forged' },
        operation: { kind: 'move-node', node_id: 'node-1', position: { x: 0, y: 0 } }
      })
    ).toThrow()
    expect(() =>
      parseMaestroDocumentLayoutMutation({
        schema_version: 1,
        protocol: 'maestro-document-layout-mutation/v1',
        mutation_id: 'layout-3',
        scope: { execution_host_id: 'local', workspace_key: 'folder:folder-1' },
        expected_revision: 0,
        operation: { kind: 'set-viewport', viewport: { center: { x: 0, y: 0 }, zoom: 5 } }
      })
    ).toThrow()
  })

  it('requires a context snapshot edge to declare its note endpoint', () => {
    const document = {
      nodes: {
        source: { kind: 'note', title: 'Source', markdown: '# Source', note_revision: 1 },
        target: { kind: 'note', title: 'Target', markdown: '# Target', note_revision: 1 }
      },
      edges: [
        {
          id: 'context-1',
          source_id: 'source',
          target_id: 'target',
          type: 'context_for',
          direction: 'forward',
          projected: false,
          context_note_id: 'source',
          context_snapshot_id: 'snapshot-1'
        }
      ]
    }
    expect(MaestroDocumentSchema.parse(document).edges[0]?.context_note_id).toBe('source')
    expect(() =>
      MaestroDocumentSchema.parse({
        ...document,
        edges: [{ ...document.edges[0], context_note_id: undefined }]
      })
    ).toThrow()
    expect(() =>
      MaestroDocumentSchema.parse({
        ...document,
        edges: [{ ...document.edges[0], context_note_id: 'other' }]
      })
    ).toThrow()
  })

  it('requires a current run anchor for authoring mutations', () => {
    const mutation = {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: 'author-note-1',
      expected_revision: 0,
      operation: {
        kind: 'create-note',
        node_id: 'note-1',
        position: { x: 0, y: 0 },
        title: 'Note',
        markdown: '# Note'
      }
    }
    expect(() =>
      parseMaestroDocumentAuthoringMutation({
        ...mutation,
        scope: { execution_host_id: 'local', workspace_key: 'folder:folder-1' }
      })
    ).toThrow()
    expect(
      parseMaestroDocumentAuthoringMutation({
        ...mutation,
        scope: {
          repository_id: 'repo-1',
          execution_host_id: 'local',
          workspace_key: 'folder:folder-1',
          run_id: 'run-1'
        }
      }).scope.run_id
    ).toBe('run-1')
  })

  it('parses only the host and workspace document read scope', () => {
    expect(
      parseMaestroDocumentReadScope({
        execution_host_id: 'local',
        workspace_key: 'folder:folder-1'
      })
    ).toEqual({ execution_host_id: 'local', workspace_key: 'folder:folder-1' })
    expect(() =>
      parseMaestroDocumentReadScope({
        execution_host_id: 'local',
        workspace_key: 'folder:folder-1',
        repository_id: 'repo-1'
      })
    ).toThrow()
    expect(() =>
      parseMaestroDocumentReadScope({ execution_host_id: 'local', workspace_key: 'not-a-key' })
    ).toThrow()
  })

  it('accepts frozen mutation and delegation fixtures', () => {
    expect(
      parseMaestroMutation(
        JSON.parse(readFileSync(resolve(fixtures, 'maestro-mutation.json'), 'utf8'))
      ).operation.kind
    ).toBe('pin-note-snapshot')
    expect(
      parseDelegationIntent(
        JSON.parse(readFileSync(resolve(fixtures, 'delegation-intent.json'), 'utf8'))
      ).placement_request.kind
    ).toBe('create-child-worktree')
  })

  it('rejects unbounded and non-Orca workspace data', () => {
    expect(() =>
      parseMaestroMutation(
        JSON.parse(readFileSync(resolve(fixtures, 'maestro-mutation-invalid.json'), 'utf8'))
      )
    ).toThrow()
    expect(() =>
      parseDelegationIntent(
        JSON.parse(readFileSync(resolve(fixtures, 'delegation-intent-invalid.json'), 'utf8'))
      )
    ).toThrow()
  })

  it('accepts bounded AgentGraphView snapshots', () => {
    expect(
      parseAgentGraphView({
        schema_version: 1,
        protocol: 'agent-graph-view/v1',
        kind: 'snapshot',
        workspace_scope: {
          schema_version: 1,
          repository_id: 'repo-1',
          canonical_root: '/repo',
          execution_host: { id: 'local', boundary: 'local' },
          orchestration_home: {
            execution_host_id: 'local',
            workspace_key: 'folder:folder-1',
            kind: 'folder',
            path: '/repo'
          },
          execution_workspace: {
            execution_host_id: 'local',
            workspace_key: 'worktree:repo-1::/repo/wt',
            kind: 'git-worktree',
            path: '/repo/wt',
            worktree_path: '/repo/wt'
          },
          base_revision: 'abc',
          dirty_paths: [],
          run_id: 'run-1',
          coordinator_generation: 1,
          binding_receipt_ref: 'artifact:receipt',
          binding_receipt_hash: `sha256:${'a'.repeat(64)}`
        },
        change: 'change-1',
        run_id: 'run-1',
        coordinator: { id: 'coordinator-1', generation: 1 },
        capabilities: { agents: [], efforts: [], placement_kinds: [], watch_deltas: true },
        nodes: [],
        edges: [],
        removed_node_ids: [],
        removed_edge_ids: [],
        revision: 0,
        cursor: null,
        from_cursor: null,
        reset_required: false,
        progress: {
          schema_version: 1,
          state: 'outcome_unknown',
          progress_percent: 0,
          task_counts: {
            approved: 0,
            running: 0,
            input_required: 0,
            blocked: 0,
            pending: 0,
            failed: 0
          },
          current_tasks: [],
          next_tasks: [],
          cleanup: {
            pending: { count: 0, ids: [], truncated: false },
            unverifiable: { count: 0, ids: [], truncated: false },
            failed: { count: 0, ids: [], truncated: false },
            retained: { count: 0, ids: [], truncated: false }
          },
          last_activity: null,
          blockers: [],
          material_findings: []
        }
      })
    ).toMatchObject({
      capabilities: { agents: [], efforts: [], placement_kinds: [], watch_deltas: true },
      progress: { schema_version: 1, state: 'outcome_unknown' }
    })
  })
})
