import { describe, expect, it } from 'vitest'
import type { ArchitectureDiagramModel } from './architecture-diagram-types'
import {
  addMembersToGroupInModel,
  analyzeExternalModelUpdate,
  applyNodePositionChangesToModel,
  createNodeForParent,
  createGroupFromSelectedNodes,
  deleteEdgesFromModel,
  deleteNodesFromModel,
  deleteReferenceEdgesFromModel,
  getNodeContextForModel,
  getVisibleGroupBubbles,
  getVisibleArchitectureView,
  reconcileExpandedPath,
  updateEdgeDataInModel
} from './architecture-diagram-model'

function fixtureModel(): ArchitectureDiagramModel {
  return {
    nodes: [
      {
        id: 'user',
        type: 'architecture',
        position: { x: 0, y: 0 },
        data: { name: 'User', description: '', kind: 'person' }
      },
      {
        id: 'shop',
        type: 'architecture',
        position: { x: 240, y: 0 },
        data: { name: 'Shop', description: '', kind: 'system', status: 'proposed' }
      },
      {
        id: 'payments',
        type: 'architecture',
        position: { x: 520, y: 0 },
        data: { name: 'Payments', description: '', kind: 'system', external: true }
      },
      {
        id: 'web',
        type: 'architecture',
        parentId: 'shop',
        position: { x: 0, y: 0 },
        data: { name: 'Web', description: '', kind: 'container', status: 'implemented' }
      },
      {
        id: 'api',
        type: 'architecture',
        parentId: 'shop',
        position: { x: 260, y: 0 },
        data: { name: 'API', description: '', kind: 'container', status: 'proposed' }
      },
      {
        id: 'handler',
        type: 'architecture',
        parentId: 'api',
        position: { x: 0, y: 0 },
        data: { name: 'Handler', description: '', kind: 'component', status: 'proposed' }
      },
      {
        id: 'operation',
        type: 'operation',
        parentId: 'handler',
        position: { x: 0, y: 0 },
        data: { name: 'listUsers', description: '', kind: 'operation', status: 'proposed' }
      }
    ],
    links: [
      { id: 'edge-user-shop', source: 'user', target: 'shop', data: { label: 'uses' } },
      {
        id: 'edge-shop-payments',
        source: 'shop',
        target: 'payments',
        data: { label: 'calls', method: 'HTTP' }
      },
      { id: 'edge-web-api', source: 'web', target: 'api', data: { label: 'requests' } },
      { id: 'edge-api-handler', source: 'api', target: 'handler', data: { label: 'owns' } }
    ],
    sourceMap: {
      api: [{ pattern: 'src/api/**/*.ts' }],
      handler: [{ pattern: 'src/api/handler.ts' }],
      operation: [{ pattern: 'src/api/handler.ts', line: 12 }]
    },
    boundaries: {
      api: [{ pattern: 'src/api/**', comment: 'api source boundary' }],
      handler: [{ pattern: 'src/api/handler.ts' }]
    },
    refPositions: { 'shop/user': { x: 10, y: -180 } },
    groups: [
      {
        id: 'backend',
        name: 'Backend',
        memberIds: ['api'],
        contract: { expect: ['thin handlers'], ask: [], never: [] }
      }
    ]
  }
}

describe('architecture diagram model view helpers', () => {
  it('shows root nodes and only root-level links when no node is expanded', () => {
    const view = getVisibleArchitectureView({
      model: fixtureModel(),
      expandedPath: [],
      changedNodeIds: new Set(),
      driftedNodeIds: new Set()
    })

    expect(view.currentParentId).toBeUndefined()
    expect(view.currentParentKind).toBeUndefined()
    expect(view.visibleNodes.map((node) => node.id)).toEqual(['user', 'shop', 'payments'])
    expect(view.visibleEdges.map((edge) => edge.id)).toEqual([
      'edge-user-shop',
      'edge-shop-payments'
    ])
  })

  it('shows child nodes plus parent-level reference nodes when drilled into a system', () => {
    const view = getVisibleArchitectureView({
      model: fixtureModel(),
      expandedPath: ['shop'],
      changedNodeIds: new Set(['api']),
      driftedNodeIds: new Set(['web'])
    })

    expect(view.currentParentId).toBe('shop')
    expect(view.currentParentKind).toBe('system')
    expect(view.visibleNodes.map((node) => node.id)).toEqual(['web', 'api', 'user', 'payments'])
    expect(view.visibleEdges.map((edge) => edge.id)).toEqual(['edge-web-api'])

    const userRef = view.visibleNodes.find((node) => node.id === 'user')
    expect(userRef?.data._reference).toBe(true)
    expect(userRef?.position).toEqual({ x: 10, y: -180 })
    expect(userRef?.data._relationships).toEqual([{ direction: 'in', label: 'uses' }])

    const api = view.visibleNodes.find((node) => node.id === 'api')
    expect(api?.data._groupName).toBe('Backend')
    expect(api?.data._changed).toBe(true)
    expect(api?.data._hasChildren).toBe(true)
    const web = view.visibleNodes.find((node) => node.id === 'web')
    expect(web?.data._drifted).toBe(true)
  })

  it('cascades node deletion through descendants, edges, source ownership, and groups', () => {
    const model = deleteNodesFromModel(fixtureModel(), ['api'])

    expect(model.nodes.map((node) => node.id)).toEqual(['user', 'shop', 'payments', 'web'])
    expect(model.links.map((edge) => edge.id)).toEqual(['edge-user-shop', 'edge-shop-payments'])
    expect(model.sourceMap).toEqual({})
    expect(model.boundaries).toEqual({})
    expect(model.groups).toEqual([])
  })

  it('updates edge labels and removes blank methods without touching other edges', () => {
    const model = updateEdgeDataInModel(fixtureModel(), 'edge-shop-payments', {
      label: 'publishes event',
      method: ''
    })

    expect(model.links.find((edge) => edge.id === 'edge-shop-payments')?.data).toEqual({
      label: 'publishes event'
    })
    expect(model.links.find((edge) => edge.id === 'edge-user-shop')?.data).toEqual({
      label: 'uses'
    })
  })

  it('deletes selected edges without deleting connected nodes', () => {
    const model = deleteEdgesFromModel(fixtureModel(), ['edge-shop-payments'])

    expect(model.nodes.map((node) => node.id)).toContain('shop')
    expect(model.nodes.map((node) => node.id)).toContain('payments')
    expect(model.links.map((edge) => edge.id)).toEqual([
      'edge-user-shop',
      'edge-web-api',
      'edge-api-handler'
    ])
  })

  it('builds the selected node get_node context from descendants, edges, groups, and source map', () => {
    const context = getNodeContextForModel(fixtureModel(), 'api')

    expect(context.descendants.map((node) => node.id)).toEqual(['handler', 'operation'])
    expect(context.internalEdges.map((edge) => edge.id)).toEqual(['edge-api-handler'])
    expect(context.externalEdges).toEqual([
      expect.objectContaining({
        id: 'edge-web-api',
        externalNodeName: 'Web',
        externalNodeKind: 'container',
        direction: 'in'
      })
    ])
    expect(context.groups).toEqual([expect.objectContaining({ id: 'backend', name: 'Backend' })])
    expect(context.sourceMap).toEqual({
      api: [{ pattern: 'src/api/**/*.ts' }],
      handler: [{ pattern: 'src/api/handler.ts' }],
      operation: [{ pattern: 'src/api/handler.ts', line: 12 }]
    })
    expect(context.boundaries).toEqual({
      api: [{ pattern: 'src/api/**', comment: 'api source boundary' }],
      handler: [{ pattern: 'src/api/handler.ts' }]
    })
  })

  it('creates the next diagram kind for the selected parent', () => {
    const model = fixtureModel()
    const shop = model.nodes.find((node) => node.id === 'shop')!
    const api = model.nodes.find((node) => node.id === 'api')!
    const handler = model.nodes.find((node) => node.id === 'handler')!

    expect(createNodeForParent(model, null).data.kind).toBe('system')
    expect(createNodeForParent(model, shop).data.kind).toBe('container')
    expect(createNodeForParent(model, api).data.kind).toBe('component')
    const codeNode = createNodeForParent(model, handler)
    expect(codeNode.data.kind).toBe('operation')
    expect(codeNode.type).toBe('operation')
  })

  it('only writes ReactFlow position changes back to the model', () => {
    const model = fixtureModel()
    const refNodeIds = new Set(['payments'])

    expect(
      applyNodePositionChangesToModel(
        model,
        [
          { id: 'shop', type: 'select', selected: true },
          { id: 'shop', type: 'dimensions', dimensions: { width: 190, height: 120 } }
        ],
        refNodeIds
      )
    ).toBeNull()

    expect(
      applyNodePositionChangesToModel(
        model,
        [{ id: 'payments', type: 'position', position: { x: 900, y: 100 } }],
        refNodeIds
      )
    ).toBeNull()

    const moved = applyNodePositionChangesToModel(
      model,
      [{ id: 'shop', type: 'position', position: { x: 320, y: 160 } }],
      refNodeIds
    )

    expect(moved?.nodes.find((node) => node.id === 'shop')?.position).toEqual({ x: 320, y: 160 })
    expect(model.nodes.find((node) => node.id === 'shop')?.position).toEqual({ x: 240, y: 0 })
  })

  it('stores moved reference node positions under the current parent', () => {
    const model = fixtureModel()
    const moved = applyNodePositionChangesToModel(
      model,
      [{ id: 'user', type: 'position', position: { x: 44, y: -220 } }],
      new Set(['user']),
      'shop'
    )

    expect(moved?.nodes.find((node) => node.id === 'user')?.position).toEqual({ x: 0, y: 0 })
    expect(moved?.refPositions?.['shop/user']).toEqual({ x: 44, y: -220 })
  })

  it('disconnects reference nodes without deleting the real external node', () => {
    const model = deleteReferenceEdgesFromModel(fixtureModel(), 'shop', ['payments'])

    expect(model.nodes.map((node) => node.id)).toContain('payments')
    expect(model.links.map((edge) => edge.id)).toEqual([
      'edge-user-shop',
      'edge-web-api',
      'edge-api-handler'
    ])
  })

  it('creates and updates groups from a multi-selection while keeping nodes in one group', () => {
    const model = fixtureModel()
    const withGroup = createGroupFromSelectedNodes(model, {
      id: 'platform',
      name: 'Platform',
      memberIds: ['web', 'api']
    })

    expect(withGroup.groups).toEqual([
      {
        id: 'platform',
        name: 'Platform',
        memberIds: ['web', 'api']
      }
    ])

    const moved = addMembersToGroupInModel(withGroup, 'platform', ['api', 'handler'])
    expect(moved.groups).toEqual([
      {
        id: 'platform',
        name: 'Platform',
        memberIds: ['web', 'api', 'handler']
      }
    ])
  })

  it('auto-drills into a single root node with children when no path is selected', () => {
    const model = fixtureModel()
    const singleRootModel = {
      ...model,
      nodes: model.nodes.filter((node) => node.id !== 'user' && node.id !== 'payments')
    }

    expect(reconcileExpandedPath(model, [])).toEqual([])
    expect(reconcileExpandedPath(singleRootModel, [])).toEqual(['shop'])
    expect(reconcileExpandedPath(singleRootModel, ['api'])).toEqual(['api'])
    expect(reconcileExpandedPath(singleRootModel, ['missing'])).toEqual([])
  })

  it('summarizes external model updates with changed node ids, old node data, and follow path', () => {
    const previous = fixtureModel()
    const incoming: ArchitectureDiagramModel = {
      ...previous,
      nodes: previous.nodes.map((node) =>
        node.id === 'operation'
          ? {
              ...node,
              position: { x: 0, y: 0 },
              data: { ...node.data, name: 'listOrders', _needsLayout: true }
            }
          : node
      )
    }

    const summary = analyzeExternalModelUpdate({
      previous,
      incoming,
      expandedPath: ['shop'],
      followExternalChanges: true
    })

    expect(summary.changedNodeIds).toEqual(new Set(['operation', 'handler']))
    expect(summary.nodeDiffs.get('operation')).toEqual(
      expect.objectContaining({ name: 'listUsers', kind: 'operation' })
    )
    expect(summary.expandedPath).toEqual(['shop', 'api'])
    expect(summary.model.nodes.find((node) => node.id === 'operation')?.position).toEqual({
      x: 0,
      y: 0
    })
  })

  it('keeps the current path when follow external changes is disabled', () => {
    const previous = fixtureModel()
    const incoming: ArchitectureDiagramModel = {
      ...previous,
      nodes: previous.nodes.map((node) =>
        node.id === 'handler' ? { ...node, data: { ...node.data, status: 'implemented' } } : node
      )
    }

    const summary = analyzeExternalModelUpdate({
      previous,
      incoming,
      expandedPath: ['shop'],
      followExternalChanges: false
    })

    expect(summary.changedNodeIds).toEqual(new Set(['handler', 'api']))
    expect(summary.expandedPath).toEqual(['shop'])
  })

  it('computes visible group bubble bounds from visible member node positions', () => {
    const model = fixtureModel()
    const view = getVisibleArchitectureView({
      model,
      expandedPath: ['shop'],
      changedNodeIds: new Set(),
      driftedNodeIds: new Set()
    })

    const bubbles = getVisibleGroupBubbles(model, view.visibleNodes)

    expect(bubbles).toEqual([
      {
        id: 'backend',
        name: 'Backend',
        x: 230,
        y: -30,
        width: 240,
        height: 220,
        memberCount: 1,
        depth: 0
      }
    ])
  })
})
