import { describe, expect, it } from 'vitest'
import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { buildFleetView, type FleetNode } from './fleet-view-model'

function card(
  paneKey: string,
  options: { parent?: string; bucket?: DashboardBucket; changedAt?: number } = {}
): DashboardCard {
  return {
    paneKey,
    ptyId: null,
    agentType: 'claude',
    bucket: options.bucket ?? 'working',
    dotState: 'working',
    task: paneKey,
    repoId: 'repo',
    worktreeId: `wt-${paneKey}`,
    tabId: `tab-${paneKey}`,
    leafId: null,
    parentPaneKey: options.parent,
    repoName: 'repo',
    worktreeName: paneKey,
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: options.changedAt ?? 1,
    unseen: false
  }
}

type NodeShape = { paneKey: string; depth: number; leafCount: number; children: NodeShape[] }

function shape(node: FleetNode): NodeShape {
  return {
    paneKey: node.card.paneKey,
    depth: node.depth,
    leafCount: node.leafCount,
    children: node.children.map(shape)
  }
}

describe('buildFleetView', () => {
  it('makes a team only of roots that spawned agents and keeps the rest independent', () => {
    const view = buildFleetView([
      card('solo-old', { bucket: 'done', changedAt: 10 }),
      card('lead', { changedAt: 20 }),
      card('worker', { parent: 'lead', bucket: 'attention', changedAt: 30 }),
      card('solo-new', { bucket: 'idle', changedAt: 40 })
    ])

    expect(view.teams.map((team) => team.root.card.paneKey)).toEqual(['lead'])
    expect(view.teams[0].size).toBe(2)
    expect(view.teams[0].counts).toEqual({ attention: 1, working: 1, done: 0, idle: 0 })
    expect(view.solo.map((solo) => solo.paneKey)).toEqual(['solo-new', 'solo-old'])
    expect(view.summary).toEqual({
      attention: 1,
      working: 1,
      done: 1,
      idle: 1,
      agents: 4,
      teams: 1
    })
  })

  it('nests a three-level team and counts the leaves under each node', () => {
    const view = buildFleetView([
      card('lead'),
      card('auditor', { parent: 'lead' }),
      card('scanner-web', { parent: 'auditor' }),
      card('scanner-mobile', { parent: 'auditor' }),
      card('writer', { parent: 'lead' })
    ])

    expect(view.teams).toHaveLength(1)
    expect(shape(view.teams[0].root)).toEqual({
      paneKey: 'lead',
      depth: 0,
      leafCount: 3,
      children: [
        {
          paneKey: 'auditor',
          depth: 1,
          leafCount: 2,
          children: [
            { paneKey: 'scanner-web', depth: 2, leafCount: 1, children: [] },
            { paneKey: 'scanner-mobile', depth: 2, leafCount: 1, children: [] }
          ]
        },
        { paneKey: 'writer', depth: 1, leafCount: 1, children: [] }
      ]
    })
  })

  it('orders teams by the latest activity of any member, not of the root', () => {
    const view = buildFleetView([
      card('quiet-lead', { changedAt: 100 }),
      card('busy-worker', { parent: 'quiet-lead', changedAt: 500 }),
      card('recent-lead', { changedAt: 300 }),
      card('recent-worker', { parent: 'recent-lead', changedAt: 200 })
    ])

    expect(view.teams.map((team) => team.root.card.paneKey)).toEqual(['quiet-lead', 'recent-lead'])
  })
})
