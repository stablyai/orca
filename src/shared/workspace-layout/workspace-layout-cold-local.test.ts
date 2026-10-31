import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { loadWorkspaceLayout } from './workspace-layout-load'
import * as workspaceLoader from './workspace-layout-load-workspace'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { workspaceSessionStateSchema } from '../workspace-session-schema'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
import type { WorkspaceLayout } from './workspace-layout-model'
import { resolveGroupOrder, type OrderCandidate } from './workspace-layout-load-order'
import { resolveTabGroupOwners } from './tab-group-owners'
import { nameBasedLoadContext, rootGroupSeed } from './workspace-layout-minted-ids'
import type { TabGroup } from '../tab-types'
import {
  populations,
  coldInput,
  discriminatingInput
} from './workspace-layout-cold-local.test-fixture'
import { GIT_KEY, FOLDER_KEY } from './workspace-layout-session.test-fixture'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const baselineReceipts = new Map([
  ['closed:10', '49c629e099e2a234f669a5e5490f29335b4ae6f00a61755b6c21d989bed38172'],
  ['closed:100', 'ce9b736f4cda74a1f53bfe347e119f217b900057886a8a43f9227532b168dc21'],
  ['home-rows:10', 'f81567477d16adf70ee850ffddd183cc98e11c8936a3e021b0679d10535af930'],
  ['home-rows:100', '16446bcd8b078097e8269fb6b24d108cd08152f85790c36ed55e5bb6e74ee56f'],
  ['home-names:10', 'ee9b22f64c4f886e217cf16721c4b3ccd9106f8af3e8b5c981e504441d1b7c70'],
  ['home-names:100', '7725a00f17b2413482cc0ad632ec5c91c2415c63781eda25803fc82dce9ab94d'],
  ['legacy:10', 'cda25919f2c535b75feeb1afd9d78344effb89236ba2965764251701827b12de'],
  ['legacy:100', 'b18ed8efbc8e12e3e5d30ff5c3c57657f3c6cf478e3c78d1dc51fa50c867cbc1'],
  ['groups:10', '6fe1956efc562d58aa6ef102af6ad718dfe1f69cf9b5582c636df9f7d5c49e6b'],
  ['groups:100', '9ecb9152c43c5ffc2ddbb729baafb334354eb5039676097c3392bbd186a68bd8'],
  ['browser:10', '52cf96e00d0048f8dd0d71cbc063adbde2a9c8d861cccffba1cb45306f625ce5'],
  ['browser:100', 'd92bdb4973cadb8c29919590e23c7a25c21b3c932035fb1c737418da13e0fc74']
])

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function context(
  events: string[],
  fail?: string,
  fault = new Error('mint fault')
): WorkspaceLayoutLoadContext {
  return {
    mintId: (seed) => {
      events.push(`id:${seed}`)
      if (seed === fail) {
        throw fault
      }
      return `minted-${seed}`
    },
    mintLeafId: (seed) => {
      events.push(`leaf:${seed}`)
      if (seed === fail) {
        throw fault
      }
      return nameBasedLoadContext().mintLeafId(seed)
    },
    editorViewsOf: (key) => {
      events.push(`editor:${key}`)
      return undefined
    },
    ptyGenerationOf: (id) => {
      events.push(`generation:${id}`)
      return 3
    }
  }
}

function measured(stored: WorkspaceSessionState) {
  const counts = {
    namingComparisons: 0,
    browserComparisons: 0,
    groupComparisons: 0,
    recordKeys: 0,
    closedCopies: 0,
    closedWrites: 0,
    closedKeyBytes: 0,
    mapGet: 0,
    mapSet: 0,
    mapHas: 0,
    setAdd: 0,
    setHas: 0,
    keyCharacters: 0
  }
  const restore: (() => void)[] = []
  const some = Array.prototype.some
  const find = Array.prototype.find
  function charge(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return
    }
    if ('contentType' in value) {
      counts.namingComparisons++
    }
    if ('kind' in value) {
      counts.browserComparisons++
    }
    if ('tabOrder' in value) {
      counts.groupComparisons++
    }
  }
  const scans = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
    this: unknown[],
    predicate,
    receiver
  ) {
    return some.call(this, (value, index, array) => {
      charge(value)
      return predicate.call(receiver, value, index, array)
    })
  })
  const finds = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
    this: unknown[],
    predicate,
    receiver
  ) {
    return find.call(this, (value, index, array) => {
      charge(value)
      return predicate.call(receiver, value, index, array)
    })
  })
  const keys = Object.keys
  const keyScan = vi.spyOn(Object, 'keys').mockImplementation((value) => {
    const result = keys(value)
    if (result.some((key) => key.startsWith('unrelated-'))) {
      counts.recordKeys += result.length
    }
    return result
  })
  const original = workspaceLoader.loadWorkspace
  const capture = vi.spyOn(workspaceLoader, 'loadWorkspace').mockImplementation((...args) => {
    const workspace = original(...args)
    let current: WorkspaceLayout['closedTerminalTabs']
    let view: WorkspaceLayout['closedTerminalTabs']
    Object.defineProperty(workspace, 'closedTerminalTabs', {
      configurable: true,
      get: () => view,
      set: (next: NonNullable<WorkspaceLayout['closedTerminalTabs']>) => {
        current = next
        view = new Proxy(next, {
          ownKeys(target) {
            const names = Object.getOwnPropertyNames(target)
            counts.closedCopies += names.length
            return names
          },
          defineProperty(target, key, descriptor) {
            counts.closedWrites++
            counts.closedKeyBytes += String(key).length
            Object.defineProperty(target, key, descriptor)
            return true
          }
        })
      }
    })
    restore.push(() => {
      delete workspace.closedTerminalTabs
      if (current !== undefined) {
        workspace.closedTerminalTabs = current
      }
    })
    return workspace
  })
  const mapGet = Map.prototype.get,
    mapSet = Map.prototype.set,
    mapHas = Map.prototype.has,
    setAdd = Set.prototype.add,
    setHas = Set.prototype.has
  const bytes = (key: unknown) => {
    if (typeof key === 'string') {
      counts.keyCharacters += key.length
    }
  }
  const mg = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
    this: Map<unknown, unknown>,
    key
  ) {
    counts.mapGet++
    bytes(key)
    return mapGet.call(this, key)
  })
  const ms = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    counts.mapSet++
    bytes(key)
    return mapSet.call(this, key, value)
  })
  const mh = vi.spyOn(Map.prototype, 'has').mockImplementation(function (
    this: Map<unknown, unknown>,
    key
  ) {
    counts.mapHas++
    bytes(key)
    return mapHas.call(this, key)
  })
  const sa = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, key) {
    counts.setAdd++
    bytes(key)
    return setAdd.call(this, key)
  })
  const sh = vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, key) {
    counts.setHas++
    bytes(key)
    return setHas.call(this, key)
  })
  const events: string[] = []
  let loaded: ReturnType<typeof loadWorkspaceLayout>
  try {
    loaded = loadWorkspaceLayout('local', stored, context(events))
  } finally {
    for (const mock of [scans, finds, keyScan, capture, mg, ms, mh, sa, sh]) {
      mock.mockRestore()
    }
    for (const release of restore) {
      release()
    }
  }
  return {
    counts,
    loaded,
    events,
    full: digest({ loaded, saved: saveWorkspaceLayout(loaded), events })
  }
}

it('preserves complete cold/reacquired/save/report receipts while charging the five local populations separately', () => {
  const small = new Map<string, ReturnType<typeof measured>['counts']>()
  for (const kind of populations) {
    for (const n of [10, 100]) {
      const stored = coldInput(kind, n)
      const parsed = workspaceSessionStateSchema.parse(stored)
      // Admission is checked before metering; salvage must retain this population, not quietly drop it.
      expect(parsed.tabsByWorktree).toEqual(stored.tabsByWorktree)
      expect(parsed.tabGroups).toEqual(stored.tabGroups)
      expect(parsed.browserTabsByWorktree).toEqual(stored.browserTabsByWorktree)
      expect(parsed.closedTerminalTabTombstonesByTabId).toEqual(
        stored.closedTerminalTabTombstonesByTabId
      )
      expect(parsed.terminalPtyIncarnationsByPaneKey).toEqual(
        stored.terminalPtyIncarnationsByPaneKey
      )
      const before = structuredClone(stored)
      const first = measured(structuredClone(parsed))
      const again = measured(structuredClone(parsed))
      expect(again.full).toBe(first.full)
      expect(first.full).toBe(baselineReceipts.get(`${kind}:${n}`))
      if (kind === 'closed') {
        expect(first.counts.closedCopies).toBe(n)
        expect(first.counts.closedWrites).toBe(n)
      }
      if (kind === 'home-rows' || kind === 'home-names') {
        expect(first.counts.namingComparisons).toBe(0)
      }
      if (kind === 'legacy') {
        expect(first.counts.recordKeys).toBe(2 * n)
      }
      if (kind === 'groups') {
        expect(first.counts.groupComparisons).toBeLessThanOrEqual(n)
      }
      if (kind === 'browser') {
        expect(first.counts.browserComparisons).toBe(0)
      }
      if (n === 10) {
        small.set(kind, first.counts)
      } else {
        const lower = small.get(kind)!
        for (const operation of ['mapGet', 'mapSet', 'mapHas', 'setAdd', 'setHas'] as const) {
          expect(first.counts[operation]).toBeLessThanOrEqual(10 * lower[operation])
        }
        // Decimal keys grow by a character; this charges logical strings, not physical allocation.
        expect(first.counts.keyCharacters).toBeLessThanOrEqual(12 * lower.keyCharacters)
      }
      expect(stored).toEqual(before)
      console.log('five-local receipt', {
        kind,
        n,
        ...first.counts,
        full: first.full,
        events: first.events
      })
    }
  }
})

it('keeps direct-API special properties, odd/empty/ambiguous suffixes, kind collisions and exact callback fault prefixes', () => {
  const stored = discriminatingInput()
  const before = structuredClone(stored)
  const events: string[] = []
  const loaded = loadWorkspaceLayout('local', stored, context(events))
  const closed = loaded.layout.workspaces[GIT_KEY].closedTerminalTabs!
  expect(Object.getPrototypeOf(closed)).toBe(Object.prototype)
  expect(Object.keys(closed)).toEqual(['1', '2', '__proto__', 'constructor', 'toString'])
  expect(Object.getOwnPropertyDescriptor(closed, '__proto__')).toEqual({
    value: { closedAt: 1, reason: undefined },
    enumerable: true,
    configurable: true,
    writable: true
  })
  expect(Object.hasOwn(closed.__proto__, 'reason')).toBe(true)
  expect(loaded.carried.unplacedClosedTabs.unknown.worktreeId).toBe('missing')
  expect(
    loaded.layout.workspaces[GIT_KEY].tabs.find((tab) => tab.entityId === 'odd:tab')
  ).toMatchObject({ panes: { root: { leafId: 'leaf:tail' } } })
  expect(
    loaded.layout.workspaces[GIT_KEY].tabs.find((tab) => tab.entityId === 'empty')
  ).toMatchObject({ panes: { root: { leafId: '' } } })
  expect(events).not.toContain('leaf:leaf:rootless')
  expect(
    loaded.layout.workspaces[GIT_KEY].tabs.filter(
      (tab) => tab.kind === 'browser' && tab.entityId === 'tab-shell'
    )
  ).toHaveLength(1)
  const prefix: string[] = []
  const fault = new Error('exact original')
  let thrown: unknown
  try {
    loadWorkspaceLayout('local', stored, context(prefix, 'leaf:ambiguous', fault))
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBe(fault)
  expect(prefix).toEqual(events.slice(0, events.indexOf('leaf:leaf:ambiguous') + 1))
  expect(stored).toEqual(before)
  expect(digest({ loaded, saved: saveWorkspaceLayout(loaded), events })).toBe(
    '22466d0445dcb213d9c9f211b40ed00f860bbf394844f00275e40815f60ba7dc'
  )
  console.log('five-local direct receipt', {
    full: digest({ loaded, saved: saveWorkspaceLayout(loaded), events }),
    events,
    prefix
  })
})

it('preserves first duplicate group, empty fallback, native NaN/tie sorting and duplicate candidate appends against the original algorithm', () => {
  const groups: TabGroup[] = [
    { id: 'empty', worktreeId: GIT_KEY, activeTabId: null, tabOrder: [] },
    { id: 'claimed', worktreeId: GIT_KEY, activeTabId: null, tabOrder: ['owned'] },
    { id: 'claimed', worktreeId: GIT_KEY, activeTabId: null, tabOrder: ['lost'] }
  ]
  const candidates: OrderCandidate[] = [
    { id: 'owned', createdAt: 1 },
    { id: 'same', groupId: 'claimed', createdAt: 2, tabBarSortOrder: Number.NaN },
    { id: 'same', createdAt: 2, rowSortOrder: Number.NaN },
    { id: 'tie', createdAt: 2 },
    { id: 'lost', groupId: 'empty', createdAt: 2 }
  ]
  // Preserve the old walk as an independent oracle, including the intentionally unchanged placed set.
  function old(storedGroups: TabGroup[], rows: OrderCandidate[], events: string[]) {
    const owners = resolveTabGroupOwners(rows, storedGroups),
      placed = new Set<string>()
    const result: { id: string; tabOrder: string[] }[] = []
    for (const stored of storedGroups) {
      if (result.some((group) => group.id === stored.id)) {
        continue
      }
      const tabOrder: string[] = []
      for (const tabId of stored.tabOrder) {
        if (owners.get(tabId) === stored.id && !placed.has(tabId)) {
          placed.add(tabId)
          tabOrder.push(tabId)
        }
      }
      result.push({ id: stored.id, tabOrder })
    }
    for (const row of rows
      .filter((entry) => !placed.has(entry.id))
      .sort(
        (a, b) =>
          (a.tabBarSortOrder ?? a.rowSortOrder ?? Infinity) -
            (b.tabBarSortOrder ?? b.rowSortOrder ?? Infinity) || a.createdAt - b.createdAt
      )) {
      let group = result.find((entry) => entry.id === row.groupId) ?? result[0]
      if (!group) {
        const seed = rootGroupSeed(GIT_KEY)
        events.push(seed)
        group = { id: `minted-${seed}`, tabOrder: [] }
        result.push(group)
      }
      group.tabOrder.push(row.id)
    }
    return result.filter((group) => group.tabOrder.length > 0)
  }
  for (const storedGroups of [groups, []]) {
    const before = structuredClone({ storedGroups, candidates }),
      oldEvents: string[] = [],
      nextEvents: string[] = []
    expect(
      resolveGroupOrder({
        storedGroups,
        candidates,
        workspaceKey: GIT_KEY,
        mintId: (seed) => {
          nextEvents.push(seed)
          return `minted-${seed}`
        }
      })
    ).toEqual(old(storedGroups, candidates, oldEvents))
    expect(nextEvents).toEqual(oldEvents)
    expect({ storedGroups, candidates }).toEqual(before)
  }
})

it('keeps first/late/unnamed home winners and skips record acquisition for explicit rootless layouts', () => {
  for (const named of ['first', 'late', 'none']) {
    const stored = coldInput('home-rows', 10)
    if (named === 'first') {
      stored.unifiedTabs![GIT_KEY][0].entityId = 'active'
    }
    if (named === 'none') {
      stored.unifiedTabs![FOLDER_KEY] = []
    }
    const loaded = loadWorkspaceLayout('local', stored, context([]))
    const owner = named === 'late' ? FOLDER_KEY : GIT_KEY
    expect(
      Object.entries(loaded.layout.workspaces).flatMap(([key, workspace]) =>
        workspace.tabs.filter((tab) => tab.kind === 'terminal').map(() => key)
      )
    ).toEqual([owner])
  }
  const stored = coldInput('legacy', 100)
  for (const row of stored.tabsByWorktree[GIT_KEY]) {
    stored.terminalLayoutsByTabId[row.id] = { root: null, activeLeafId: null, expandedLeafId: null }
  }
  const skipped = measured(stored)
  // Saving/reporting still enumerates the carried record once; loading never acquires it.
  expect(skipped.counts.recordKeys).toBe(100)
  expect(skipped.events.filter((event) => event.startsWith('leaf:'))).toEqual([])
})
