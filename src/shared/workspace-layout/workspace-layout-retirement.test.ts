import { expect, it, vi } from 'vitest'
import * as retirement from './workspace-layout-load-retirement'
import { applyLegacySurfaceTombstones } from './workspace-layout-load-bindings'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import type { TabGroupLayoutNode } from '../tab-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import {
  cohortInput,
  graph,
  groupLeaf,
  groupSplit,
  paneLeaf,
  paneSplit,
  phaseInput,
  readRetirementProperty,
  terminal,
  tombstone
} from './workspace-layout-retirement.test-fixture'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function context(): WorkspaceLayoutLoadContext {
  const named = nameBasedLoadContext()
  return {
    mintId: (seed) => (seed === 'tab:cohort' ? 'cohort' : named.mintId(seed)),
    mintLeafId: (seed) => (seed === 'leaf:cohort:0' ? leaf(1) : named.mintLeafId(seed)),
    ptyGenerationOf: () => undefined,
    editorViewsOf: () => undefined
  }
}

function retirementInput(kind: 'L' | 'G', n: number) {
  const input = phaseInput()
  const workspace = input.model.workspaces[GIT_KEY]
  if (kind === 'L') {
    // Many tombstones in one tab whose N surviving leaves stay.
    let root = paneLeaf('a')
    for (let i = 0; i < n; i++) {
      root = paneSplit(root, paneLeaf(`surviving-${i}`))
      workspace.leaves![`surviving-${i}`] = { title: String(i) }
    }
    workspace.tabs[0] = terminal('target', 'X', root)
    input.session.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      [
        tombstone('X', 'a'),
        ...Array.from({ length: n }, (_, i) => tombstone('X', `surviving-${i}`))
      ].map((value, i) => [String(i), value])
    )
  } else {
    // N groups close together under an N-deep group layout.
    input.session.terminalSurfaceTombstonesByPaneKey = {
      a: tombstone('X', 'a'),
      b: tombstone('X', 'b')
    }
    workspace.groups = Array.from({ length: n }, (_, i) => ({ id: `g-${i}`, tabOrder: ['target'] }))
    workspace.groups.push({ id: 'g2', tabOrder: ['keep'] })
    let root = groupLeaf('g2')
    for (let i = 0; i < n; i++) {
      root = groupSplit(groupLeaf(`g-${i}`), root)
    }
    workspace.groupLayout = root
  }
  return input
}

function meterRetirement(input: ReturnType<typeof phaseInput>) {
  const count = { nodeReads: 0, recordFields: 0 }
  const observed = <T extends object>(value: T): T =>
    new Proxy(value, {
      get: (target, key, receiver) => {
        count.nodeReads++
        return readRetirementProperty(target, key, receiver)
      }
    })
  const wrapPane = (node: TerminalPaneLayoutNode | null): TerminalPaneLayoutNode | null =>
    !node
      ? node
      : observed(
          node.type === 'leaf'
            ? node
            : { ...node, first: wrapPane(node.first)!, second: wrapPane(node.second)! }
        )
  const wrapGroup = (node: TabGroupLayoutNode): TabGroupLayoutNode =>
    observed(
      node.type === 'leaf'
        ? node
        : { ...node, first: wrapGroup(node.first), second: wrapGroup(node.second) }
    )
  const countKeys = <T extends object>(value: T): T =>
    new Proxy(value, {
      ownKeys: (target) => {
        const keys = Reflect.ownKeys(target)
        count.recordFields += keys.length
        return keys
      }
    })
  for (const value of Object.values(input.model.workspaces)) {
    for (const tab of value.tabs) {
      if (tab.kind === 'terminal') {
        tab.panes.root = wrapPane(tab.panes.root)
      }
    }
    if (value.groupLayout) {
      value.groupLayout = wrapGroup(value.groupLayout)
    }
    if (value.leaves) {
      value.leaves = countKeys(value.leaves)
    }
  }
  input.model.workspaces = countKeys(input.model.workspaces)
  return count
}

it('retires legacy surfaces in linear work as surviving leaves and closing groups grow', () => {
  for (const kind of ['L', 'G'] as const) {
    const [small, large] = [10, 100].map((n) => {
      const input = retirementInput(kind, n)
      const control = structuredClone(input)
      const expected = applyLegacySurfaceTombstones(control.model, control.session, control.carried)
      const count = meterRetirement(input)
      const result = retirement.retireLoadedLegacySurfaces(
        input.model,
        input.session,
        input.carried
      )
      expect(graph(result)).toEqual(graph(expected))
      return count
    })
    const factor = kind === 'G' ? 16 : 12
    expect(large.nodeReads).toBeLessThanOrEqual(factor * small.nodeReads + 32)
    expect(large.recordFields).toBeLessThanOrEqual(factor * small.recordFields + 32)
  }
})

it('collects skew-tree leaves with one read per leaf at N and 10N', () => {
  for (const n of [10, 100]) {
    const leaves = Array.from({ length: n }, (_, i) => paneLeaf(String(i)))
    let reads = 0
    const instrument = (node: TerminalPaneLayoutNode): TerminalPaneLayoutNode =>
      node.type === 'leaf'
        ? {
            type: 'leaf',
            get leafId() {
              reads++
              return node.leafId
            }
          }
        : { ...node, first: instrument(node.first), second: instrument(node.second) }
    const skew = leaves.slice(1).reduce((root, node) => paneSplit(root, node), leaves[0])
    expect(collectLayoutLeafIdsInOrder(instrument(skew))).toEqual(leaves.map((_, i) => String(i)))
    expect(reads).toBe(n)
  }
})

it('keeps the carried surviving split shared after a skipped-cohort loader retirement', () => {
  const stored = cohortInput()
  const shared = paneSplit(paneLeaf(leaf(4)), paneLeaf(leaf(6)))
  stored.terminalLayoutsByTabId['row-a'].root = paneSplit(paneLeaf(leaf(3)), shared)
  stored.terminalLayoutsByTabId.unowned = {
    root: shared,
    activeLeafId: leaf(4),
    expandedLeafId: null
  }
  stored.terminalSurfaceTombstonesByPaneKey = {
    only: tombstone('row-a', leaf(3), 'retired-incarnation')
  }
  const before = graph(stored)
  const next = loadWorkspaceLayout('local', stored, context())
  expect(graph(stored)).toEqual(before)
  const carried = next.carried.unownedTerminalLayouts.unowned.root
  const row = next.layout.workspaces[GIT_KEY].tabs.find(
    (tab) => tab.kind === 'terminal' && tab.entityId === 'row-a'
  )
  if (row?.kind !== 'terminal') {
    throw new Error('expected surviving row-a cohort')
  }
  expect(row.panes.root).toBe(carried)
  const cohortRoots = next.layout.workspaces[GIT_KEY].tabs.flatMap((tab) =>
    tab.kind === 'terminal' && tab.id === 'cohort' ? [tab.panes.root] : []
  )
  expect(cohortRoots).toHaveLength(2)
  expect(cohortRoots.every((root) => root === carried)).toBe(true)
})
