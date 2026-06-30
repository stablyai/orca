import { describe, expect, it } from 'vitest'
import type { ArchitectureDiagramModel } from './architecture-diagram-types'
import {
  pushArchitectureUndoSnapshot,
  createEmptyArchitectureModel,
  findCompletedArchitectureSyncPane,
  fingerprintArchitectureModel,
  modelWithNodeDrafts,
  modelWithVisibleSourcePattern,
  nodeUpdateInputFromDiagramPatch,
  sourcePatternForNode
} from './useArchitectureModelController'

describe('architecture model controller helpers', () => {
  it('creates a complete empty Scryer model for the current project', () => {
    expect(createEmptyArchitectureModel('/repo')).toEqual({
      nodes: [],
      links: [],
      startingLevel: 'system',
      sourceMap: {},
      boundaries: {},
      projectPath: '/repo',
      refPositions: {},
      groups: []
    })
  })

  it('fingerprints diagram models with stable key ordering', () => {
    const model: ArchitectureDiagramModel = {
      nodes: [
        {
          id: 'api',
          type: 'architecture',
          position: { x: 10, y: 20 },
          data: { kind: 'container', name: 'API', description: '' }
        }
      ],
      links: [],
      startingLevel: 'system',
      sourceMap: {},
      boundaries: {},
      projectPath: '/repo',
      refPositions: {},
      groups: []
    }
    const reordered = {
      groups: [],
      refPositions: {},
      projectPath: '/repo',
      boundaries: {},
      sourceMap: {},
      startingLevel: 'system',
      links: [],
      nodes: model.nodes
    } as ArchitectureDiagramModel

    expect(fingerprintArchitectureModel(model)).toBe(fingerprintArchitectureModel(reordered))
  })

  it('resolves the source pattern for a selected node from boundaries first', () => {
    const model = createEmptyArchitectureModel('/repo')
    model.sourceMap = { api: [{ pattern: 'src/api.ts' }] }
    model.boundaries = { api: [{ pattern: 'src/api/**' }] }

    expect(sourcePatternForNode(model, 'api')).toBe('src/api/**')
    expect(sourcePatternForNode({ ...model, boundaries: {} }, 'api')).toBe('src/api.ts')
    expect(sourcePatternForNode(model, null)).toBe('')
  })

  it('merges the visible source pattern into a model snapshot for history replay', () => {
    const model = createEmptyArchitectureModel('/repo')

    const withPattern = modelWithVisibleSourcePattern(model, 'api', ' src/api/** ')
    expect(withPattern.boundaries?.api).toEqual([{ pattern: 'src/api/**' }])
    expect(model.boundaries?.api).toBeUndefined()

    const withoutPattern = modelWithVisibleSourcePattern(withPattern, 'api', '')
    expect(withoutPattern.boundaries?.api).toBeUndefined()
  })

  it('merges node drafts into a model snapshot for history replay', () => {
    const model = createEmptyArchitectureModel('/repo')
    model.nodes = [
      {
        id: 'api',
        type: 'architecture',
        position: { x: 0, y: 0 },
        data: { kind: 'system', name: 'System 1', description: '' }
      }
    ]

    const withDraft = modelWithNodeDrafts(
      model,
      new Map([['api', { name: 'Shop System', description: 'Draft description' }]])
    )

    expect(withDraft.nodes[0]?.data).toMatchObject({
      name: 'Shop System',
      description: 'Draft description'
    })
    expect(model.nodes[0]?.data.name).toBe('System 1')
  })

  it('normalizes renderer node patches into catalog node update input', () => {
    expect(
      nodeUpdateInputFromDiagramPatch('operation-1', {
        kind: 'operation',
        name: 'handleRequest',
        description: '',
        technology: 'TypeScript',
        shape: 'cylinder',
        properties: [{ label: 'id', description: 'identifier' }],
        _needsLayout: true
      })
    ).toEqual({
      nodes: [
        {
          node_id: 'operation-1',
          kind: 'symbol',
          name: 'handleRequest',
          description: '',
          technology: 'TypeScript',
          appearance: { shape: 'cylinder' },
          properties: [{ label: 'id', description: 'identifier' }]
        }
      ]
    })

    expect(nodeUpdateInputFromDiagramPatch('api', { shape: undefined })).toEqual({
      nodes: [{ node_id: 'api', appearance: { shape: null } }]
    })
    expect(nodeUpdateInputFromDiagramPatch('api', { _needsLayout: true })).toBeNull()
  })

  it('detects the launched sync agent reporting done on its tab', () => {
    expect(
      findCompletedArchitectureSyncPane({
        tabId: 'tab-sync',
        startedAt: 100,
        agentStatusByPaneKey: {
          'tab-other:0': {
            paneKey: 'tab-other:0',
            state: 'done',
            prompt: '',
            updatedAt: 150,
            stateStartedAt: 150,
            agentType: 'codex',
            stateHistory: []
          },
          'tab-sync:0': {
            paneKey: 'tab-sync:0',
            state: 'done',
            prompt: '',
            updatedAt: 160,
            stateStartedAt: 160,
            agentType: 'codex',
            stateHistory: []
          }
        }
      })
    ).toEqual({ paneKey: 'tab-sync:0', interrupted: false })
  })

  it('ignores stale and interrupted sync agent completion states', () => {
    expect(
      findCompletedArchitectureSyncPane({
        tabId: 'tab-sync',
        startedAt: 100,
        agentStatusByPaneKey: {
          'tab-sync:0': {
            paneKey: 'tab-sync:0',
            state: 'done',
            prompt: '',
            updatedAt: 99,
            stateStartedAt: 99,
            agentType: 'codex',
            stateHistory: []
          }
        }
      })
    ).toBeNull()

    expect(
      findCompletedArchitectureSyncPane({
        tabId: 'tab-sync',
        startedAt: 100,
        agentStatusByPaneKey: {
          'tab-sync:0': {
            paneKey: 'tab-sync:0',
            state: 'done',
            prompt: '',
            updatedAt: 150,
            stateStartedAt: 150,
            agentType: 'codex',
            stateHistory: [],
            interrupted: true
          }
        }
      })
    ).toEqual({ paneKey: 'tab-sync:0', interrupted: true })
  })

  it('keeps the last 10 undo snapshots and batches rapid edits for one second', () => {
    const snapshots = Array.from({ length: 12 }, (_, index) =>
      createEmptyArchitectureModel(`/repo-${index}`)
    )
    let stack: ArchitectureDiagramModel[] = []
    let batchStartedAt: number | null = null

    for (const [index, snapshot] of snapshots.entries()) {
      const result = pushArchitectureUndoSnapshot(stack, snapshot, {
        batchStartedAt,
        now: index * 1_100
      })
      stack = result.stack
      batchStartedAt = result.batchStartedAt
    }

    expect(stack).toHaveLength(10)
    expect(stack[0].projectPath).toBe('/repo-2')
    expect(stack.at(-1)?.projectPath).toBe('/repo-11')

    const batched = pushArchitectureUndoSnapshot(stack, createEmptyArchitectureModel('/rapid'), {
      batchStartedAt,
      now: 12_050
    })
    expect(batched.stack).toBe(stack)
    expect(batched.batchStartedAt).toBe(batchStartedAt)
  })
})
