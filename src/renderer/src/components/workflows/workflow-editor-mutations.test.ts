import { describe, expect, it } from 'vitest'
import { authenticationFeatureTemplate } from '../../../../shared/workflow/workflow-templates-team'
import { validateWorkflowDefinition } from '../../../../shared/workflow/workflow-validation'
import {
  addWorkflowNode,
  connectWorkflowNodes,
  copyWorkflowNodes,
  createBlankWorkflowPreset,
  pasteWorkflowNodes,
  removeWorkflowElements
} from './workflow-editor-mutations'

describe('workflow editor mutations', () => {
  it('refuses routes into control nodes and duplicate dependencies', () => {
    const preset = authenticationFeatureTemplate()
    expect(connectWorkflowNodes(preset, 'communication', 'backend', 'join')).toEqual({
      error: 'Communication routes connect agents only.'
    })
    expect(connectWorkflowNodes(preset, 'dependency', 'start', 'coordinator')).toEqual({
      error: 'That dependency already exists.'
    })
    expect(connectWorkflowNodes(preset, 'dependency', 'end', 'coordinator')).toMatchObject({
      error: expect.any(String)
    })
  })

  it('adds a backend-to-frontend route only when asked, and the policy then permits it', () => {
    const preset = authenticationFeatureTemplate()
    const created = connectWorkflowNodes(preset, 'communication', 'backend', 'frontend')
    expect(created).toEqual({ id: 'c-backend-frontend' })
    expect(
      preset.definition.communication.find((edge) => edge.id === 'c-backend-frontend')?.enabled
    ).toBe(true)
  })

  it('removes a node with every edge touching it and clears a decision that read it', () => {
    const preset = authenticationFeatureTemplate()
    removeWorkflowElements(preset, { nodes: ['reviewer'] })
    const { definition } = preset
    expect(
      definition.dependencies.some(
        (edge) => edge.source === 'reviewer' || edge.target === 'reviewer'
      )
    ).toBe(false)
    expect(
      definition.communication.some(
        (edge) => edge.source === 'reviewer' || edge.target === 'reviewer'
      )
    ).toBe(false)
    expect(definition.nodes.find((node) => node.id === 'decision')).toMatchObject({
      subjectNodeId: null
    })
    expect(preset.layout.positions.reviewer).toBeUndefined()
  })

  it('pastes copies with fresh ids and keeps only the edges among the copied nodes', () => {
    const preset = authenticationFeatureTemplate()
    const clipboard = copyWorkflowNodes(preset, ['coordinator', 'backend'])
    const ids = pasteWorkflowNodes(preset, clipboard, preset.definition)
    expect(ids).toEqual(['coordinator-copy', 'backend-copy'])
    expect(
      preset.definition.communication.filter((edge) => edge.source === 'coordinator-copy')
    ).toEqual([expect.objectContaining({ target: 'backend-copy' })])
    const allIds = [
      ...preset.definition.nodes,
      ...preset.definition.dependencies,
      ...preset.definition.communication
    ].map((entry) => entry.id)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('starts a new workflow that validates and grows with unique ids', () => {
    const preset = createBlankWorkflowPreset('wf-test', '2026-11-03T00:00:00.000Z')
    expect(
      validateWorkflowDefinition(preset.definition).issues.filter(
        (issue) => issue.severity === 'error'
      )
    ).toEqual([])
    expect(addWorkflowNode(preset, 'agent', { x: 0, y: 0 })).toBe('agent-2')
  })
})
