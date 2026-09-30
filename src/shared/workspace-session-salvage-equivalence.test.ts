/* Differential corpus: the salvaging read boundary is the "a bad persisted payload falls back to
 * defaults instead of crashing the renderer" gate, so the traversal-cost work in zod-salvage.ts and
 * the discriminated layout unions have to be provably output-identical. This file pins the previous
 * implementation and asserts both produce the same accepted value, the same fallback and the same
 * repair diagnostics over valid and malformed payloads alike. */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as ZodModule from 'zod'
import { parseWorkspaceSessionSalvaging } from './workspace-session-salvage'

type LegacyParse = typeof parseWorkspaceSessionSalvaging

/** The pre-optimization zod-salvage: containers zod validated and copied before the transform
 *  re-walked them, and no explicit '__proto__'/symbol-key handling of its own. */
function legacySalvageModule(): Record<string, unknown> {
  const MAX_REPORTED_SALVAGE_PATHS = 100
  type DropCollector = { paths: string[]; count: number }
  let dropCollector: DropCollector | null = null
  const dropPath: (string | number)[] = []

  function collectSalvageDrops<T>(parse: () => T): {
    value: T
    droppedPaths: string[]
    droppedCount: number
  } {
    const previousCollector = dropCollector
    const previousPath = [...dropPath]
    const collector: DropCollector = { paths: [], count: 0 }
    dropCollector = collector
    dropPath.length = 0
    try {
      const value = parse()
      return { value, droppedPaths: collector.paths, droppedCount: collector.count }
    } finally {
      dropCollector = previousCollector
      dropPath.splice(0, dropPath.length, ...previousPath)
    }
  }

  function reportDrop(segment: string | number): void {
    if (!dropCollector) {
      return
    }
    dropCollector.count += 1
    if (dropCollector.paths.length < MAX_REPORTED_SALVAGE_PATHS) {
      dropCollector.paths.push([...dropPath, segment].join('.'))
    }
  }

  function inEntry<T>(segment: string | number, parse: () => T): T {
    dropPath.push(segment)
    try {
      return parse()
    } finally {
      dropPath.pop()
    }
  }

  function parseEntry(
    schema: z.ZodType,
    raw: unknown
  ): { success: true; data: unknown } | { success: false } {
    try {
      const parsed = schema.safeParse(raw)
      return parsed.success ? { success: true, data: parsed.data } : { success: false }
    } catch {
      return { success: false }
    }
  }

  function salvagingArray(item: z.ZodType): z.ZodType {
    return z.array(z.unknown()).transform((values) =>
      values.flatMap((value, index) => {
        const parsed = inEntry(index, () => parseEntry(item, value))
        if (parsed.success) {
          return [parsed.data]
        }
        reportDrop(index)
        return []
      })
    ) as z.ZodType
  }

  function salvagingRecord(
    key: z.ZodType,
    value: z.ZodType,
    accepts?: (key: string, value: unknown) => boolean
  ): z.ZodType {
    return z.record(z.string(), z.unknown()).transform((entries) => {
      const kept: Record<string, unknown> = Object.create(null)
      for (const [entryKey, entryValue] of Object.entries(entries)) {
        const parsed = parseEntry(key, entryKey).success
          ? inEntry(entryKey, () => parseEntry(value, entryValue))
          : null
        if (parsed?.success && (!accepts || accepts(entryKey, parsed.data))) {
          kept[entryKey] = parsed.data
          continue
        }
        reportDrop(entryKey)
      }
      return { ...kept }
    }) as z.ZodType
  }

  function salvaged(name: string, schema: z.ZodType, fallback: () => unknown): z.ZodType {
    return z.unknown().transform((raw, ctx) => {
      if (raw === undefined) {
        ctx.addIssue({ code: 'custom', message: 'required', input: raw })
        return z.NEVER
      }
      const parsed = inEntry(name, () => parseEntry(schema, raw))
      if (parsed.success) {
        return parsed.data
      }
      reportDrop(name)
      return fallback()
    })
  }

  return {
    collectSalvageDrops,
    salvagingArray,
    salvagingRecord,
    salvagedField: (name: string, schema: z.ZodType, fallback: () => unknown) =>
      salvaged(name, schema, fallback),
    salvagedOptional: (name: string, schema: z.ZodType) =>
      salvaged(name, schema, () => undefined).optional()
  }
}

const WT = 'repo-1::/home/user/project'

function terminalTab(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: WT,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function unifiedTab(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function layout(root: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { root, activeLeafId: 'leaf-1', expandedLeafId: null, ...overrides }
}

const SPLIT = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', leafId: 'leaf-1' },
  second: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'leaf-2' },
    second: { type: 'leaf', leafId: 'leaf-3' },
    ratio: 0.5
  }
}

const GROUP_SPLIT = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', groupId: 'group-1' },
  second: { type: 'leaf', groupId: 'group-2' }
}

/** A hole, not an explicit undefined: the old container copied it away before the transform ran. */
function sparseTabs(): unknown[] {
  const tabs: unknown[] = [terminalTab('a')]
  tabs[2] = terminalTab('b')
  return tabs
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

/** Valid payloads first, then one malformed variant per subtree the salvage path rescues alone. */
const CORPUS: [string, unknown][] = [
  ['minimal valid', session()],
  [
    'fully populated valid',
    session({
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: 'tab-1',
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null,
      tabsByWorktree: { [WT]: [terminalTab('tab-1'), terminalTab('tab-2')] },
      terminalLayoutsByTabId: {
        'tab-1': layout(SPLIT, {
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' },
          buffersByLeafId: { 'leaf-1': 'hello' },
          scrollbackRefsByLeafId: { 'leaf-1': 'ref-1' },
          titlesByLeafId: { 'leaf-1': 'zsh' }
        }),
        'tab-2': layout({ type: 'leaf', leafId: 'leaf-9' })
      },
      unifiedTabs: { [WT]: [unifiedTab('tab-1'), unifiedTab('tab-2')] },
      tabGroups: { [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: [] }] },
      tabGroupLayouts: { [WT]: GROUP_SPLIT, 'repo-2::/other': { type: 'leaf', groupId: 'g' } },
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      activeTabIdByWorktree: { [WT]: 'tab-1' },
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      activeWorktreeIdsOnShutdown: [WT],
      activeConnectionIdsAtShutdown: ['conn-1'],
      lastVisitedAtByWorktreeId: { [WT]: 1_700_000_000_000 },
      remoteSessionIdsByTabId: { 'tab-1': 'remote-1' },
      terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 'inc-1' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 3 },
      defaultTerminalTabsAppliedByWorktreeId: { [WT]: true },
      markdownFrontmatterVisible: { 'doc-1': true },
      activeFileIdByWorktree: { [WT]: null },
      activeBrowserTabIdByWorktree: { [WT]: null },
      browserUrlHistory: [
        {
          url: 'https://example.com',
          normalizedUrl: 'https://example.com',
          title: 'Example',
          lastVisitedAt: 1,
          visitCount: 2
        }
      ]
    })
  ],
  ['not an object', 'nope'],
  ['null', null],
  ['array', []],
  ['foreign object', { unrelated: 'payload', count: 3 }],
  ['missing required field', { activeRepoId: null }],
  ['required scalar wrong type', session({ activeRepoId: 42 })],
  ['required record replaced by a scalar', session({ tabsByWorktree: 'nope' })],
  ['required record replaced by an array', session({ tabsByWorktree: [] })],
  ['required record replaced by a Map', session({ tabsByWorktree: new Map() })],
  ['required record replaced by a Date', session({ tabsByWorktree: new Date(0) })],
  ['required record replaced by null', session({ tabsByWorktree: null })],
  ['optional record replaced by a scalar', session({ terminalTopologyRevisionByRepoId: 'nope' })],
  ['optional record explicitly undefined', session({ unifiedTabs: undefined })],
  ['array field replaced by a record', session({ tabsByWorktree: { [WT]: { a: 1 } } })],
  ['array field replaced by a string', session({ tabsByWorktree: { [WT]: 'nope' } })],
  [
    'array holding a corrupt element',
    session({ tabsByWorktree: { [WT]: [terminalTab('a'), { id: 'bad' }] } })
  ],
  ['array holding only corrupt elements', session({ tabsByWorktree: { [WT]: [1, 2, 3] } })],
  ['sparse array', session({ tabsByWorktree: { [WT]: sparseTabs() } })],
  ['array holding undefined', session({ tabsByWorktree: { [WT]: [undefined, terminalTab('a')] } })],
  [
    'record with a __proto__ key',
    session({ terminalPtyIncarnationsByPaneKey: JSON.parse('{"__proto__":"x","ok":"inc-1"}') })
  ],
  [
    'record with a numeric key',
    session({ terminalPtyIncarnationsByPaneKey: { 0: 'inc-0', b: 'inc-b' } })
  ],
  ['record with a dotted key', session({ terminalPtyIncarnationsByPaneKey: { 'a.b': 'inc-1' } })],
  ['record with an empty key', session({ terminalPtyIncarnationsByPaneKey: { '': 'inc-1' } })],
  ['record value wrong type', session({ terminalPtyIncarnationsByPaneKey: { a: 'ok', b: 123 } })],
  [
    'record key rejected by its key schema',
    session({ clientHostedBrowserCloseIntentsByEnvironment: { '': [] } })
  ],
  [
    'nested record corrupt',
    session({
      terminalLayoutsByTabId: { 'tab-1': layout(SPLIT, { ptyIdsByLeafId: { a: 'p', b: 7 } }) }
    })
  ],
  [
    'nested record replaced by an array',
    session({ terminalLayoutsByTabId: { 'tab-1': layout(SPLIT, { ptyIdsByLeafId: [] }) } })
  ],
  [
    'layout leaf id wrong type',
    session({ terminalLayoutsByTabId: { 'tab-1': layout({ type: 'leaf', leafId: 42 }) } })
  ],
  [
    'layout split direction unknown',
    session({ terminalLayoutsByTabId: { 'tab-1': layout({ ...SPLIT, direction: 'row' }) } })
  ],
  [
    'layout node type unknown',
    session({ terminalLayoutsByTabId: { 'tab-1': layout({ type: 'stack', leafId: 'a' }) } })
  ],
  [
    'layout node type missing',
    session({ terminalLayoutsByTabId: { 'tab-1': layout({ leafId: 'a' }) } })
  ],
  ['layout node not an object', session({ terminalLayoutsByTabId: { 'tab-1': layout('leaf') } })],
  ['layout node null root', session({ terminalLayoutsByTabId: { 'tab-1': layout(null) } })],
  [
    'layout split missing a child',
    session({
      terminalLayoutsByTabId: {
        'tab-1': layout({
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'a' }
        })
      }
    })
  ],
  [
    'layout split with a corrupt grandchild',
    session({
      terminalLayoutsByTabId: {
        'tab-1': layout({
          ...SPLIT,
          second: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 1 },
            second: { type: 'leaf', leafId: 'b' }
          }
        })
      }
    })
  ],
  [
    'layout split ratio wrong type',
    session({ terminalLayoutsByTabId: { 'tab-1': layout({ ...SPLIT, ratio: 'half' }) } })
  ],
  [
    'group layout leaf corrupt',
    session({
      tabGroupLayouts: {
        [WT]: { type: 'split', direction: 'row', first: { type: 'leaf', groupId: 42 } }
      }
    })
  ],
  [
    'group layout valid alongside corrupt',
    session({ tabGroupLayouts: { [WT]: GROUP_SPLIT, bad: { type: 'leaf', groupId: 1 } } })
  ],
  [
    'unified tab missing a required field',
    session({ unifiedTabs: { [WT]: [unifiedTab('a'), { id: 'b' }] } })
  ],
  [
    'unified tab unknown viewMode falls back',
    session({ unifiedTabs: { [WT]: [unifiedTab('a', { viewMode: 'wat' })] } })
  ],
  [
    'tab group order wrong type',
    session({
      tabGroups: { [WT]: [{ id: 'g', worktreeId: WT, activeTabId: null, tabOrder: 'nope' }] }
    })
  ],
  [
    'sleeping agent key mismatch',
    session({ sleepingAgentSessionsByPaneKey: { 'tab-bad:leaf': { paneKey: 'different:leaf' } } })
  ],
  [
    'browser history entry corrupt',
    session({
      browserUrlHistory: [
        {
          url: 'https://a',
          normalizedUrl: 'https://a',
          title: 't',
          lastVisitedAt: 1,
          visitCount: 1
        },
        { url: 5 }
      ]
    })
  ],
  ['browser history not an array', session({ browserUrlHistory: {} })],
  [
    'tombstone record corrupt',
    session({ terminalSurfaceTombstonesByPaneKey: { 'tab-1:leaf-1': { worktreeId: 42 } } })
  ],
  [
    'non-finite recency dropped',
    session({ lastVisitedAtByWorktreeId: { [WT]: Number.POSITIVE_INFINITY } })
  ],
  [
    'systemic single-field corruption',
    session({
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`tab-${i}`, layout({ type: 'leaf', leafId: i })])
      )
    })
  ],
  [
    'drop reporting past the path cap',
    session({
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [`k-${i}`, i])
      )
    })
  ]
]

describe('salvage equivalence with the pre-optimization implementation', () => {
  let legacyParse: LegacyParse
  let legacyUnionsBuilt = 0

  beforeAll(async () => {
    // Why: the legacy schema has to be built from the legacy combinators and from plain unions, so
    // both changed surfaces are compared, not just the container fast path.
    vi.doMock('./zod-salvage', () => legacySalvageModule())
    vi.doMock('zod', async () => {
      const actual = await vi.importActual<typeof ZodModule>('zod')
      return {
        ...actual,
        z: {
          ...actual.z,
          discriminatedUnion: (_key: string, options: z.ZodType[]) => {
            legacyUnionsBuilt += 1
            return actual.z.union(options)
          }
        }
      }
    })
    vi.resetModules()
    legacyParse = (await import('./workspace-session-salvage.js')).parseWorkspaceSessionSalvaging
    // Why: the recursive layout unions are lazy, so force them to build before the mock is dropped.
    legacyParse(session({ tabGroupLayouts: { [WT]: GROUP_SPLIT } }))
    legacyParse(session({ terminalLayoutsByTabId: { 'tab-1': layout(SPLIT) } }))
    vi.doUnmock('./zod-salvage')
    vi.doUnmock('zod')
    vi.resetModules()
  })

  it('builds a legacy parser from the legacy combinators and plain unions', () => {
    expect(legacyParse).not.toBe(parseWorkspaceSessionSalvaging)
    expect(legacyUnionsBuilt).toBeGreaterThanOrEqual(2)
  })

  it.each(CORPUS)('matches the legacy result for %s', (_name, payload) => {
    const legacy = legacyParse(payload)
    const current = parseWorkspaceSessionSalvaging(payload)

    expect(current.ok).toBe(legacy.ok)
    if (!legacy.ok || !current.ok) {
      return
    }
    expect(current.value).toStrictEqual(legacy.value)
    expect(current.droppedCount).toBe(legacy.droppedCount)
    expect(current.droppedPaths.toSorted()).toEqual(legacy.droppedPaths.toSorted())
  })

  it('rejects the same payloads the legacy parser rejects', () => {
    const rejected = CORPUS.filter(([, payload]) => !legacyParse(payload).ok)
    expect(rejected.length).toBeGreaterThan(0)
    for (const [, payload] of rejected) {
      expect(parseWorkspaceSessionSalvaging(payload).ok).toBe(false)
    }
  })

  it('rejects a record carrying an enumerable symbol key, as zod.record did', () => {
    const withSymbol: Record<string, unknown> = { 'tab-1:leaf-1': 'inc-1' }
    withSymbol[Symbol('extra') as unknown as string] = 'x'
    const payload = session({ terminalPtyIncarnationsByPaneKey: withSymbol })
    const legacy = legacyParse(payload)
    const current = parseWorkspaceSessionSalvaging(payload)
    expect(current.ok).toBe(true)
    expect(legacy.ok).toBe(true)
    if (current.ok && legacy.ok) {
      expect(current.value.terminalPtyIncarnationsByPaneKey).toStrictEqual(
        legacy.value.terminalPtyIncarnationsByPaneKey
      )
      expect(current.droppedPaths).toEqual(legacy.droppedPaths)
    }
  })

  it('keeps a non-enumerable own key out of both results', () => {
    const hidden: Record<string, unknown> = { 'tab-1:leaf-1': 'inc-1' }
    Object.defineProperty(hidden, 'hiddenKey', { value: 'nope', enumerable: false })
    const payload = session({ terminalPtyIncarnationsByPaneKey: hidden })
    const legacy = legacyParse(payload)
    const current = parseWorkspaceSessionSalvaging(payload)
    expect(current.ok && legacy.ok).toBe(true)
    if (current.ok && legacy.ok) {
      expect(current.value.terminalPtyIncarnationsByPaneKey).toStrictEqual(
        legacy.value.terminalPtyIncarnationsByPaneKey
      )
    }
  })
})
