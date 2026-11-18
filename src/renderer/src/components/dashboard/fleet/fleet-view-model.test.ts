import { describe, expect, it } from 'vitest'
import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { buildFleetView, type FleetNode } from './fleet-view-model'

function card(
  paneKey: string,
  options: {
    parent?: string
    bucket?: DashboardBucket
    changedAt?: number
    repo?: string
    host?: ExecutionHostId
  } = {}
): DashboardCard {
  const repo = options.repo ?? 'repo'
  return {
    paneKey,
    ptyId: null,
    agentType: 'claude',
    bucket: options.bucket ?? 'working',
    dotState: 'working',
    task: paneKey,
    repoId: `id-${repo}`,
    worktreeId: `wt-${paneKey}`,
    tabId: `tab-${paneKey}`,
    leafId: null,
    parentPaneKey: options.parent,
    repoName: repo,
    worktreeName: paneKey,
    executionHostId: options.host,
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

function paneKeys(node: FleetNode): string[] {
  return [node.card.paneKey, ...node.children.flatMap(paneKeys)]
}

describe('buildFleetView', () => {
  it('makes a team only of roots that spawned agents and keeps the rest independent', () => {
    const view = buildFleetView([
      card('solo-old', { bucket: 'done', changedAt: 10 }),
      card('lead', { changedAt: 20 }),
      card('worker', { parent: 'lead', bucket: 'attention', changedAt: 30 }),
      card('solo-new', { bucket: 'idle', changedAt: 40 })
    ])

    expect(view.projects).toHaveLength(1)
    const [project] = view.projects
    expect(project.teams.map((team) => team.root.card.paneKey)).toEqual(['lead'])
    expect(project.teams[0].size).toBe(2)
    expect(project.teams[0].counts).toEqual({ attention: 1, working: 1, done: 0, idle: 0 })
    expect(project.solo.map((solo) => solo.paneKey)).toEqual(['solo-new', 'solo-old'])
    expect(view.summary).toEqual({
      attention: 1,
      working: 1,
      done: 1,
      idle: 1,
      agents: 4,
      teams: 1,
      projects: 1
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

    expect(view.projects[0].teams).toHaveLength(1)
    expect(shape(view.projects[0].teams[0].root)).toEqual({
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

    expect(view.projects[0].teams.map((team) => team.root.card.paneKey)).toEqual([
      'quiet-lead',
      'recent-lead'
    ])
  })

  it("keeps a team whole under its root's project when a worker runs in another project", () => {
    const view = buildFleetView([
      card('lead', { repo: 'api' }),
      card('docs-writer', { parent: 'lead', repo: 'docs', bucket: 'attention' }),
      card('docs-solo', { repo: 'docs', bucket: 'done' })
    ])

    expect(view.projects.map((project) => project.repoName)).toEqual(['api', 'docs'])
    const [api, docs] = view.projects
    expect(api.teams.map((team) => paneKeys(team.root))).toEqual([['lead', 'docs-writer']])
    expect(api.agents).toBe(2)
    expect(api.counts).toEqual({ attention: 1, working: 1, done: 0, idle: 0 })
    expect(docs.teams).toEqual([])
    expect(docs.solo.map((solo) => solo.paneKey)).toEqual(['docs-solo'])
    expect(docs.agents).toBe(1)
    expect(docs.counts).toEqual({ attention: 0, working: 0, done: 1, idle: 0 })
  })

  it('splits one repo into a project per execution host', () => {
    const view = buildFleetView([
      card('on-laptop', { repo: 'api', host: 'local' }),
      card('on-server', { repo: 'api', host: 'ssh:build-box' })
    ])

    expect(view.summary.projects).toBe(2)
    expect(view.projects.map((project) => project.solo.map((solo) => solo.paneKey))).toEqual([
      ['on-laptop'],
      ['on-server']
    ])
  })

  it('orders projects by name regardless of which one was active last', () => {
    const view = buildFleetView([
      card('web-agent', { repo: 'web', changedAt: 900 }),
      card('api10-agent', { repo: 'api10', changedAt: 500 }),
      card('api9-agent', { repo: 'api9', changedAt: 100 })
    ])

    expect(view.projects.map((project) => project.repoName)).toEqual(['api9', 'api10', 'web'])
  })
})
