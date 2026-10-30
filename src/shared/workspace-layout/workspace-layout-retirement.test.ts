import { expect, it, vi } from 'vitest'
import * as retirement from './workspace-layout-load-retirement'
import * as storedFields from './stored-record-fields'
import * as legacyPersistence from './workspace-layout-legacy-persistence'
import { removeGroupLayoutLeaf } from './tab-group-layout-tree'
import { applyLegacySurfaceTombstones } from './workspace-layout-load-bindings'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import type { TabGroupLayoutNode } from '../tab-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import type { LayoutLeaf } from './workspace-layout-model'
import { GIT_KEY, leaf, addWorkspace, emptySession } from './workspace-layout-session.test-fixture'
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

function expectOriginalFailure(action: () => unknown, fault: unknown): void {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBe(fault)
}

it('keeps instrumentation getter receivers, symbol lookup and original faults transparent', () => {
  const key = Symbol('inherited observation')
  const parent = {
    label: 'parent',
    get [key]() {
      return this.label
    }
  }
  const fault = new Error('observation getter')
  const target = {
    label: 'target',
    get name() {
      return this.label
    }
  }
  Object.setPrototypeOf(target, parent)
  expect(readRetirementProperty(target, key, { label: 'receiver' })).toBe('receiver')
  Object.defineProperty(target, 'fault', {
    get() {
      throw fault
    }
  })
  expectOriginalFailure(() => readRetirementProperty(target, 'fault', target), fault)
  const reads: PropertyKey[] = []
  const observed = new Proxy(target, {
    get(source, property, receiver) {
      reads.push(property)
      return readRetirementProperty(source, property, receiver)
    }
  })
  graph(observed)
  expect(reads).toEqual(['label', 'name', 'label'])
})

function comparePhase(input: ReturnType<typeof phaseInput>) {
  const before = graph({ model: input.model, session: input.session })
  const copy = structuredClone(input)
  const expected = applyLegacySurfaceTombstones(copy.model, copy.session, copy.carried)
  const candidate = retirement.retireLoadedLegacySurfaces(input.model, input.session, input.carried)
  expect(graph({ model: candidate, carried: input.carried })).toEqual(
    graph({ model: expected, carried: copy.carried })
  )
  expect(graph({ model: input.model, session: input.session })).toEqual(before)
  return { expected, candidate, before }
}

it('matches sequential cohort, own-property, carried and duplicate-group frontier outcomes including earlier gained slots', () => {
  const input = phaseInput()
  const workspace = input.model.workspaces[GIT_KEY]
  workspace.tabs.unshift({
    kind: 'browser',
    id: 'target',
    entityId: 'earlier-content',
    createdAt: 0,
    customTitle: null,
    color: null
  })
  workspace.tabs.splice(1, 0, terminal('target', 'other', paneLeaf('other')))
  workspace.tabs.push(terminal('next', 'X', paneLeaf('next')))
  workspace.groups[1].tabOrder.push('next')
  input.session.terminalSurfaceTombstonesByPaneKey!['4'] = tombstone('X', 'next')
  const before = graph(input.model)
  const result = comparePhase(input)
  expect(graph(input.model)).toEqual(before)
  expect(result.candidate.workspaces[GIT_KEY].tabs.map((tab) => tab.id)).toEqual(['keep'])
  expect(result.candidate.workspaces[GIT_KEY].groupLayout).toEqual(
    groupSplit(groupLeaf('g1'), groupLeaf('g2'))
  )
  expect(input.carried.unplacedIncarnations).toEqual({ 'X:a': 'success-stays' })
  const across = phaseInput()
  across.model.workspaces['folder:next'] = {
    worktreeId: 'folder:next',
    tabs: [terminal('later', 'X', paneLeaf('next'))],
    groups: [{ id: 'later-group', tabOrder: ['later'] }]
  }
  across.session.terminalSurfaceTombstonesByPaneKey!['4'] = tombstone('X', 'next')
  const { candidate: crossWorkspace } = comparePhase(across)
  expect(crossWorkspace.workspaces['folder:next'].tabs).toEqual([])
  // Stop before death to compare the final shared panes and distinct cohort tab objects.
  const partial = phaseInput()
  partial.model.workspaces[GIT_KEY].tabs.unshift({ ...workspace.tabs[0] })
  partial.session.terminalSurfaceTombstonesByPaneKey = { only: tombstone('X', 'a') }
  const { candidate } = comparePhase(partial)
  const [first, second] = candidate.workspaces[GIT_KEY].tabs
  expect(first).not.toBe(second)
  expect(
    first.kind === 'terminal' && second.kind === 'terminal' && first.panes === second.panes
  ).toBe(true)

  for (const key of ['__proto__', 'constructor', 'toString', '1', '2']) {
    const special = phaseInput()
    const target = special.model.workspaces[GIT_KEY]
    target.tabs = [terminal('target', 'X', paneLeaf(key))]
    const leaves: Record<string, LayoutLeaf> = {}
    Object.defineProperty(leaves, key, {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true
    })
    leaves.remaining = { title: 'retained' }
    target.leaves = leaves
    special.session.terminalSurfaceTombstonesByPaneKey = { one: tombstone('X', key) }
    const { candidate: next } = comparePhase(special)
    expect(Object.getPrototypeOf(next.workspaces[GIT_KEY].leaves)).toBe(Object.prototype)
    expect(Object.keys(next.workspaces[GIT_KEY].leaves!)).toEqual(['remaining'])
  }
  const absent = phaseInput()
  delete absent.model.workspaces[GIT_KEY].leaves
  const { candidate: zero } = comparePhase(absent)
  expect(Object.hasOwn(zero.workspaces[GIT_KEY], 'leaves')).toBe(true)
  expect(zero.workspaces[GIT_KEY].leaves).toBeUndefined()
})

it('matches small generated duplicate-group frontiers and preserves the generic sibling oracle identity', () => {
  const sibling = groupSplit(groupLeaf('g1'), groupLeaf('g2'))
  expect(removeGroupLayoutLeaf(groupSplit(groupLeaf('g1'), sibling), 'g1')).toBe(sibling)
  const trees: TabGroupLayoutNode[] = [groupLeaf('g1'), groupLeaf('g2')]
  for (let depth = 0; depth < 3; depth++) {
    const previous = trees.slice()
    for (const branch of previous) {
      trees.push(groupSplit(groupLeaf('g1'), branch), groupSplit(branch, groupLeaf('g1')))
    }
  }
  for (const tree of trees) {
    const input = phaseInput()
    input.model.workspaces[GIT_KEY].groupLayout = tree
    comparePhase(input)
  }
})

it('keeps first-own-deletion prototype transitions and the exact Q0 legacy allocation', () => {
  const seeded = () => {
    const input = phaseInput()
    input.model.workspaces[GIT_KEY].tabs[0] = terminal(
      'target',
      'X',
      paneSplit(paneLeaf('a'), paneLeaf('inherited'))
    )
    const leaves: Record<string, LayoutLeaf> = { a: { ptyId: 'pty-a' } }
    Object.defineProperty(leaves, 'ownUndefined', { value: undefined, enumerable: true })
    Object.setPrototypeOf(leaves, { inherited: { ptyId: 'different' } })
    input.model.workspaces[GIT_KEY].leaves = leaves
    input.session.terminalSurfaceTombstonesByPaneKey = {
      first: tombstone('X', 'a'),
      afterSpread: tombstone('X', 'inherited')
    }
    return input
  }
  const left = seeded(),
    right = seeded()
  const expected = applyLegacySurfaceTombstones(left.model, left.session, left.carried)
  const actual = retirement.retireLoadedLegacySurfaces(right.model, right.session, right.carried)
  expect(graph(actual)).toEqual(graph(expected))
  expect(Object.getPrototypeOf(actual.workspaces[GIT_KEY].leaves)).toBe(Object.prototype)
  expect(Object.hasOwn(actual.workspaces[GIT_KEY].leaves!, 'ownUndefined')).toBe(true)
  const q0 = phaseInput()
  delete q0.session.terminalSurfaceTombstonesByPaneKey
  const next = retirement.retireLoadedLegacySurfaces(q0.model, q0.session, q0.carried)
  expect(next).not.toBe(q0.model)
  expect(next.workspaces).toBe(q0.model.workspaces)
  expect(next.legacy).not.toBe(q0.model.legacy)
  expect(next.legacy.terminalRowOwners).not.toBe(q0.model.legacy.terminalRowOwners)
  expect(graph(next)).toEqual(graph(applyLegacySurfaceTombstones(q0.model, q0.session, q0.carried)))
})

function context(
  events: string[],
  fail?: string,
  fault: unknown = new Error('exact fault')
): WorkspaceLayoutLoadContext {
  const named = nameBasedLoadContext()
  const event = (value: string) => {
    events.push(value)
    if (value === fail) {
      throw fault
    }
  }
  return {
    mintId: (seed) => {
      event(`id:${seed}`)
      return seed === 'tab:cohort' ? 'cohort' : named.mintId(seed)
    },
    mintLeafId: (seed) => {
      event(`leaf:${seed}`)
      return seed === 'leaf:cohort:0' ? leaf(1) : named.mintLeafId(seed)
    },
    ptyGenerationOf: (id) => {
      event(`generation:${id}`)
      return undefined
    },
    editorViewsOf: (key) => {
      event(`editor:${key}`)
      return undefined
    }
  }
}

it('runs the actual loader G/C/Z callbacks and compares complete save/report, aliases and original fault prefixes', () => {
  const stored = cohortInput()
  const before = structuredClone(stored)
  const actualEvents: string[] = []
  const candidate = loadWorkspaceLayout('local', structuredClone(stored), context(actualEvents))
  const oracle = vi
    .spyOn(retirement, 'retireLoadedLegacySurfaces')
    .mockImplementation(applyLegacySurfaceTombstones)
  const expectedEvents: string[] = []
  let expected: ReturnType<typeof loadWorkspaceLayout>
  try {
    expected = loadWorkspaceLayout('local', structuredClone(stored), context(expectedEvents))
  } finally {
    oracle.mockRestore()
  }
  expect(graph(candidate)).toEqual(graph(expected))
  expect(saveWorkspaceLayout(candidate)).toEqual(saveWorkspaceLayout(expected))
  expect(actualEvents).toEqual(expectedEvents)
  expect(actualEvents).toContain('id:tab:cohort')
  expect(actualEvents).toContain('leaf:leaf:cohort:0')
  expect(candidate.layout.workspaces[GIT_KEY].tabs.map((tab) => tab.entityId)).toEqual(['row-c'])
  expect(candidate.carried.unplacedIncarnations[`row-a:${leaf(3)}`]).toBe('carried-a')
  expect(candidate.carried.unplacedIncarnations[`row-a:${leaf(4)}`]).toBeUndefined()
  expect(stored).toEqual(before)
  for (const fail of [`editor:${GIT_KEY}`, 'id:tab:cohort', `generation:${leaf(1)}`]) {
    const fault = new Error(fail)
    const prefix: string[] = []
    expectOriginalFailure(
      () => loadWorkspaceLayout('local', stored, context(prefix, fail, fault)),
      fault
    )
    expect(prefix).toEqual(actualEvents.slice(0, actualEvents.indexOf(fail) + 1))
  }
  const z = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'g', tabs: [{ id: 'z', leaves: [[leaf(9)]] }] }
  ])
  z.terminalSurfaceTombstonesByPaneKey = { z: tombstone('z', leaf(9)) }
  const loadedZ = loadWorkspaceLayout('local', z, nameBasedLoadContext())
  expect(loadedZ.layout.workspaces[GIT_KEY].tabs).toEqual([])
  expect(Object.hasOwn(loadedZ.layout.workspaces[GIT_KEY], 'leaves')).toBe(true)
  expect(loadedZ.layout.workspaces[GIT_KEY].leaves).toBeUndefined()
})

it('keeps containment short-circuit ahead of a hidden branch and never acquires it for a replacement', () => {
  const input = phaseInput()
  const fault = new Error('hidden subtree')
  const root = paneSplit(paneLeaf('a'), paneLeaf('b'))
  Object.defineProperty(root, 'second', {
    get: () => {
      throw fault
    }
  })
  input.model.workspaces[GIT_KEY].tabs = [terminal('target', 'X', root)]
  input.session.terminalSurfaceTombstonesByPaneKey = {
    replaced: { ...tombstone('X', 'a'), ptyId: 'different' }
  }
  const candidate = retirement.retireLoadedLegacySurfaces(input.model, input.session, input.carried)
  expect(candidate.workspaces).toBe(input.model.workspaces)
  expect(() =>
    applyLegacySurfaceTombstones(input.model, input.session, input.carried)
  ).not.toThrow()
  input.session.terminalSurfaceTombstonesByPaneKey.replaced.ptyId = 'pty-a'
  expectOriginalFailure(
    () => retirement.retireLoadedLegacySurfaces(input.model, input.session, input.carried),
    fault
  )
  expectOriginalFailure(
    () => applyLegacySurfaceTombstones(input.model, input.session, input.carried),
    fault
  )
})

it('keeps the collector fresh, ordered and complete with duplicate/shared leaves and first-before-second original faults', () => {
  const old = (node: TerminalPaneLayoutNode | null | undefined): string[] =>
    !node ? [] : node.type === 'leaf' ? [node.leafId] : [...old(node.first), ...old(node.second)]
  let skew = paneLeaf('first')
  let balanced = paneLeaf('shared')
  for (let i = 0; i < 7; i++) {
    skew = paneSplit(skew, paneLeaf(String(i)))
    balanced = paneSplit(balanced, balanced)
  }
  for (const root of [undefined, null, paneLeaf(''), skew, balanced]) {
    expect(collectLayoutLeafIdsInOrder(root)).toEqual(old(root))
    expect(collectLayoutLeafIdsInOrder(root)).not.toBe(collectLayoutLeafIdsInOrder(root))
  }
  const events: string[] = []
  const fault = new Error('first leaf')
  const root = paneSplit(paneLeaf('a'), paneLeaf('b'))
  Object.defineProperty(root.first, 'leafId', {
    get: () => {
      events.push('first')
      throw fault
    }
  })
  Object.defineProperty(root, 'second', {
    get: () => {
      events.push('second')
      return paneLeaf('b')
    }
  })
  expectOriginalFailure(() => collectLayoutLeafIdsInOrder(root), fault)
  expect(events).toEqual(['first'])
  events.length = 0
  expectOriginalFailure(() => old(root), fault)
  expect(events).toEqual(['first'])
})

it('charges independent retirement populations and original/final legacy work without repeated whole-tree or record construction', () => {
  const originalLegacy = legacyPersistence.updateLegacyPersistence
  const receipts: {
    kind: string
    n: number
    nodeReads: number
    recordFields: number
    arrayReads: number
    dictionaryOps: number
    legacyCalls: number
  }[] = []
  for (const kind of ['Q', 'V', 'L', 'T', 'W', 'F', 'E', 'J', 'G', 'X', 'O'] as const) {
    for (const n of [10, 100]) {
      const input = phaseInput()
      const workspace = input.model.workspaces[GIT_KEY]
      input.session.terminalSurfaceTombstonesByPaneKey = {
        a: tombstone('X', 'a'),
        b: tombstone('X', 'b')
      }
      if (kind === 'Q') {
        input.session.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
          Array.from({ length: n }, (_, i) => [String(i), tombstone('missing', String(i))])
        )
      } else if (kind === 'V' || kind === 'L') {
        let root = paneLeaf('a')
        for (let i = 0; i < n; i++) {
          root = paneSplit(root, paneLeaf(`surviving-${i}`))
        }
        workspace.tabs[0] = terminal('target', 'X', root)
        if (kind === 'L') {
          for (let i = 0; i < n; i++) {
            workspace.leaves![`surviving-${i}`] = { title: String(i) }
          }
          input.session.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
            [
              tombstone('X', 'a'),
              ...Array.from({ length: n }, (_, i) => tombstone('X', `surviving-${i}`))
            ].map((value, i) => [String(i), value])
          )
        }
      } else if (kind === 'T') {
        workspace.tabs.unshift(
          ...Array.from({ length: n }, (_, i) => ({
            kind: 'browser' as const,
            id: 'target',
            entityId: String(i),
            createdAt: i,
            customTitle: null,
            color: null
          }))
        )
      } else if (kind === 'W') {
        for (let i = 0; i < n; i++) {
          input.model.workspaces[`unrelated-${i}`] = { worktreeId: String(i), tabs: [], groups: [] }
        }
      } else if (kind === 'F') {
        for (let i = 0; i < n; i++) {
          workspace.leaves![`unrelated-${i}`] = { title: String(i) }
        }
      } else if (kind === 'E') {
        workspace.groups[0].tabOrder = Array.from({ length: n }, () => 'target')
      } else if (kind === 'J') {
        let root = groupLeaf('g2')
        for (let i = 0; i < n; i++) {
          root = groupSplit(groupLeaf('g1'), root)
        }
        workspace.groupLayout = root
      } else if (kind === 'X') {
        workspace.tabs[0].customTitle = 'x'.repeat(n)
      } else if (kind === 'O') {
        workspace.tabs.push(
          ...Array.from({ length: n }, (_, i) => ({
            kind: 'browser' as const,
            id: `output-${i}`,
            entityId: String(i),
            createdAt: i,
            customTitle: null,
            color: null
          }))
        )
      } else {
        workspace.groups = Array.from({ length: n }, (_, i) => ({
          id: `g-${i}`,
          tabOrder: ['target']
        }))
        workspace.groups.push({ id: 'g2', tabOrder: ['keep'] })
        let root = groupLeaf('g2')
        for (let i = 0; i < n; i++) {
          root = groupSplit(groupLeaf(`g-${i}`), root)
        }
        workspace.groupLayout = root
      }
      const count = {
        kind,
        n,
        nodeReads: 0,
        recordFields: 0,
        arrayReads: 0,
        dictionaryOps: 0,
        legacyCalls: 0
      }
      const copies = structuredClone(input)
      const control = structuredClone(input)
      const expected = applyLegacySurfaceTombstones(copies.model, copies.session, copies.carried)
      const meter = (
        data: typeof input,
        count: { nodeReads: number; recordFields: number; arrayReads: number }
      ) => {
        const wrapPane = (node: TerminalPaneLayoutNode | null): TerminalPaneLayoutNode | null => {
          if (!node) {
            return node
          }
          const value =
            node.type === 'leaf'
              ? node
              : { ...node, first: wrapPane(node.first)!, second: wrapPane(node.second)! }
          return new Proxy(value, {
            get: (target, key, receiver) => {
              count.nodeReads++
              return readRetirementProperty(target, key, receiver)
            }
          })
        }
        const wrapGroup = (node: TabGroupLayoutNode): TabGroupLayoutNode => {
          const value =
            node.type === 'leaf'
              ? node
              : { ...node, first: wrapGroup(node.first), second: wrapGroup(node.second) }
          return new Proxy(value, {
            get: (target, key, receiver) => {
              count.nodeReads++
              return readRetirementProperty(target, key, receiver)
            }
          })
        }
        const wrapArray = <T>(items: T[]): T[] =>
          new Proxy(items, {
            get: (target, key, receiver) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                count.arrayReads++
              }
              return readRetirementProperty(target, key, receiver)
            }
          })
        for (const value of Object.values(data.model.workspaces)) {
          for (const tab of value.tabs) {
            if (tab.kind === 'terminal') {
              tab.panes.root = wrapPane(tab.panes.root)
            }
          }
          value.tabs = wrapArray(value.tabs)
          value.groups.forEach((group) => {
            group.tabOrder = wrapArray(group.tabOrder)
          })
          value.groups = wrapArray(value.groups)
          if (value.groupLayout) {
            value.groupLayout = wrapGroup(value.groupLayout)
          }
          if (value.leaves) {
            value.leaves = new Proxy(value.leaves, {
              ownKeys: (target) => {
                const keys = Reflect.ownKeys(target)
                count.recordFields += keys.length
                return keys
              }
            })
          }
        }
        data.model.workspaces = new Proxy(data.model.workspaces, {
          ownKeys: (target) => {
            const keys = Reflect.ownKeys(target)
            count.recordFields += keys.length
            return keys
          }
        })
      }
      meter(input, count)
      const oracleCount = { nodeReads: 0, recordFields: 0, arrayReads: 0 }
      meter(control, oracleCount)
      let oldCopyFields = 0
      const withoutKey = storedFields.withoutKey
      const copyBoundary = vi
        .spyOn(storedFields, 'withoutKey')
        .mockImplementation(
          <T>(
            record: Record<string, T> | undefined,
            key: string
          ): Record<string, T> | undefined => {
            if (record && Object.hasOwn(record, key)) {
              oldCopyFields += Object.keys(record).length
            }
            return withoutKey(record, key)
          }
        )
      try {
        applyLegacySurfaceTombstones(control.model, control.session, control.carried)
      } finally {
        copyBoundary.mockRestore()
      }
      const oldWork = { ...oracleCount, copyFieldsAtWithoutKey: oldCopyFields }
      const mapGet = Map.prototype.get,
        mapSet = Map.prototype.set,
        setHas = Set.prototype.has,
        setAdd = Set.prototype.add
      const spies = [
        vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key
        ) {
          count.dictionaryOps++
          return mapGet.call(this, key)
        }),
        vi.spyOn(Map.prototype, 'set').mockImplementation(function (
          this: Map<unknown, unknown>,
          key,
          value
        ) {
          count.dictionaryOps++
          return mapSet.call(this, key, value)
        }),
        vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, key) {
          count.dictionaryOps++
          return setHas.call(this, key)
        }),
        vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, key) {
          count.dictionaryOps++
          return setAdd.call(this, key)
        })
      ]
      const legacy = vi
        .spyOn(legacyPersistence, 'updateLegacyPersistence')
        .mockImplementation((...args) => {
          count.legacyCalls++
          return originalLegacy(...args)
        })
      let candidate: ReturnType<typeof retirement.retireLoadedLegacySurfaces>
      try {
        candidate = retirement.retireLoadedLegacySurfaces(input.model, input.session, input.carried)
      } finally {
        for (const spy of spies) {
          spy.mockRestore()
        }
        legacy.mockRestore()
      }
      const measured = { ...count }
      expect(graph(candidate)).toEqual(graph(expected))
      expect(input.carried).toEqual(copies.carried)
      expect(measured.legacyCalls).toBe(1)
      const smaller = receipts.find((row) => row.kind === kind)
      if (smaller) {
        const factor = kind === 'G' || kind === 'J' ? 16 : 12
        for (const field of ['nodeReads', 'recordFields', 'arrayReads', 'dictionaryOps'] as const) {
          expect(measured[field]).toBeLessThanOrEqual(factor * smaller[field] + 32)
        }
      }
      if (kind === 'L' && n === 100) {
        expect(oldWork.nodeReads).toBeGreaterThan(10 * measured.nodeReads)
        expect(oldWork.copyFieldsAtWithoutKey).toBeGreaterThan(10 * measured.recordFields)
      }
      const output = {
        tabs: candidate.workspaces[GIT_KEY].tabs.length,
        characters: JSON.stringify(candidate).length
      }
      console.info('retirement source/oracle/output', { kind, n, oldWork, measured, output })
      receipts.push(measured)
    }
  }
  console.info('retirement production phase logical work', receipts)
})

it('counts the compatible kernel work on balanced and skew N/10N trees and keeps recursive cycle failures', () => {
  const old = (node: TerminalPaneLayoutNode | null | undefined): string[] =>
    !node ? [] : node.type === 'leaf' ? [node.leafId] : [...old(node.first), ...old(node.second)]
  const receipts: { n: number; shape: string; oldCopied: number; nextLeafReads: number }[] = []
  for (const n of [10, 100]) {
    for (const shape of ['balanced', 'skew']) {
      let nodes = Array.from({ length: n }, (_, i) => paneLeaf(String(i)))
      if (shape === 'balanced') {
        while (nodes.length > 1) {
          nodes = nodes.flatMap((node, i) =>
            i % 2 ? [] : [nodes[i + 1] ? paneSplit(node, nodes[i + 1]) : node]
          )
        }
      } else {
        nodes = [nodes.slice(1).reduce((root, node) => paneSplit(root, node), nodes[0])]
      }
      let oldCopied = 0
      const countedOld = (node: TerminalPaneLayoutNode | null | undefined): string[] => {
        const result = !node
          ? []
          : node.type === 'leaf'
            ? [node.leafId]
            : [...countedOld(node.first), ...countedOld(node.second)]
        const iterate = result[Symbol.iterator].bind(result)
        Object.defineProperty(result, Symbol.iterator, {
          value: function* () {
            for (const value of { [Symbol.iterator]: iterate }) {
              oldCopied++
              yield value
            }
          }
        })
        return result
      }
      let nextLeafReads = 0
      const instrument = (node: TerminalPaneLayoutNode): TerminalPaneLayoutNode =>
        node.type === 'leaf'
          ? {
              type: 'leaf',
              get leafId() {
                nextLeafReads++
                return node.leafId
              }
            }
          : { ...node, first: instrument(node.first), second: instrument(node.second) }
      const expected = countedOld(nodes[0])
      const copying = oldCopied
      const actual = collectLayoutLeafIdsInOrder(instrument(nodes[0]))
      expect(actual).toEqual(old(nodes[0]))
      expect(actual).toEqual(expected)
      expect(nextLeafReads).toBe(n)
      expect(copying).toBeGreaterThan(n)
      receipts.push({ n, shape, oldCopied: copying, nextLeafReads })
    }
  }
  const cyclic = paneSplit(paneLeaf('a'), paneLeaf('b'))
  if (cyclic.type === 'split') {
    cyclic.first = cyclic
  }
  expect(() => old(cyclic)).toThrow(RangeError)
  expect(() => collectLayoutLeafIdsInOrder(cyclic)).toThrow(RangeError)
  const input = phaseInput()
  input.model.workspaces[GIT_KEY].tabs = [terminal('target', 'X', cyclic)]
  input.session.terminalSurfaceTombstonesByPaneKey = { missing: tombstone('X', 'missing') }
  expect(() => applyLegacySurfaceTombstones(input.model, input.session, input.carried)).toThrow(
    RangeError
  )
  expect(() =>
    retirement.retireLoadedLegacySurfaces(input.model, input.session, input.carried)
  ).toThrow(RangeError)
  console.info('collector private child-array copying', receipts)
})

it.each(['unchanged generic oracle', 'selected E'] as const)(
  'retains the carried surviving split alias after an actual skipped-cohort loader retirement: %s',
  (mode) => {
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
    const nextEvents: string[] = []
    const entry = vi.spyOn(retirement, 'retireLoadedLegacySurfaces')
    if (mode === 'unchanged generic oracle') {
      entry.mockImplementation(applyLegacySurfaceTombstones)
    }
    let next: ReturnType<typeof loadWorkspaceLayout>
    try {
      next = loadWorkspaceLayout('local', stored, context(nextEvents))
      expect(entry).toHaveBeenCalledTimes(1)
      const [phase] = entry.mock.calls[0]
      const phaseRow = phase.workspaces[GIT_KEY].tabs.find(
        (tab) => tab.kind === 'terminal' && tab.entityId === 'row-a'
      )
      if (phaseRow?.kind !== 'terminal' || phaseRow.panes.root?.type !== 'split') {
        throw new Error('expected skipped row-a root at selected E boundary')
      }
      expect(shared).toBe(stored.terminalLayoutsByTabId.unowned.root)
      expect(phaseRow.panes.root.second).toBe(
        entry.mock.calls[0][2].unownedTerminalLayouts.unowned.root
      )
    } finally {
      entry.mockRestore()
    }
    const replace = vi
      .spyOn(retirement, 'retireLoadedLegacySurfaces')
      .mockImplementation(applyLegacySurfaceTombstones)
    const oldEvents: string[] = []
    let old: ReturnType<typeof loadWorkspaceLayout>
    try {
      old = loadWorkspaceLayout('local', stored, context(oldEvents))
      expect(replace).toHaveBeenCalledTimes(1)
    } finally {
      replace.mockRestore()
    }
    const row = (value: ReturnType<typeof loadWorkspaceLayout>) =>
      value.layout.workspaces[GIT_KEY].tabs.find(
        (tab) => tab.kind === 'terminal' && tab.entityId === 'row-a'
      )
    const oldRow = row(old),
      nextRow = row(next)
    if (oldRow?.kind !== 'terminal' || nextRow?.kind !== 'terminal') {
      throw new Error('expected surviving row-a cohort')
    }
    expect(oldEvents).toContain('id:tab:cohort')
    expect(nextEvents).toEqual(oldEvents)
    expect(graph(stored)).toEqual(before)
    expect(next).toEqual(old)
    expect(graph(nextRow.panes.root)).toEqual(graph(oldRow.panes.root))
    expect(saveWorkspaceLayout(next)).toEqual(saveWorkspaceLayout(old))
    expect(oldRow.panes.root).toBe(old.carried.unownedTerminalLayouts.unowned.root)
    const roots = (value: ReturnType<typeof loadWorkspaceLayout>) =>
      value.layout.workspaces[GIT_KEY].tabs.flatMap((tab) =>
        tab.kind === 'terminal' && tab.id === 'cohort' ? [tab.panes.root] : []
      )
    const oldRoots = roots(old),
      nextRoots = roots(next)
    expect(oldRoots).toHaveLength(2)
    expect(nextRoots).toHaveLength(2)
    expect(oldRoots.every((root) => root === old.carried.unownedTerminalLayouts.unowned.root)).toBe(
      true
    )
    console.info('carried-alias differential receipt', {
      mode,
      oldOracleAlias: oldRow.panes.root === old.carried.unownedTerminalLayouts.unowned.root,
      actualPathAlias: nextRow.panes.root === next.carried.unownedTerminalLayouts.unowned.root,
      oldCohortAliasCount: oldRoots.filter(
        (root) => root === old.carried.unownedTerminalLayouts.unowned.root
      ).length,
      actualCohortAliasCount: nextRoots.filter(
        (root) => root === next.carried.unownedTerminalLayouts.unowned.root
      ).length,
      ownKeys: Object.keys(nextRow.panes.root ?? {}),
      ordinaryPrototype: Object.getPrototypeOf(nextRow.panes.root) === Object.prototype,
      fullValuesEventsSaveEqual: true
    })
    expect(nextRow.panes.root).toBe(next.carried.unownedTerminalLayouts.unowned.root)
    expect(graph(next)).toEqual(graph(old))
  }
)
