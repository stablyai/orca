import { expect, it, vi } from 'vitest'
import * as workspaceLoader from './workspace-layout-load-workspace'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { coldInput } from './workspace-layout-cold-local.test-fixture'
import { emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

function oldReader(session: WorkspaceSessionState) {
  return (tabId: string): string | undefined => {
    const leaves = new Set(
      [
        ...Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}),
        ...Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}),
        ...Object.keys(session.terminalSurfaceTombstonesByPaneKey ?? {})
      ].flatMap((key) => (key.startsWith(`${tabId}:`) ? [key.slice(tabId.length + 1)] : []))
    )
    return leaves.size === 1 ? [...leaves][0] : undefined
  }
}

it('preserves literal distinct suffixes and property-before-enumeration order without reading record values', () => {
  const session = emptySession()
  const keys = [
    'empty:',
    'odd:tab:a:b',
    'ambiguous:a',
    'ambiguous:b',
    '__proto__:leaf',
    'constructor:leaf',
    ':empty-id',
    'unicode:\ud800',
    'unicode:\ud800:tail',
    'unicode:\uffff',
    'lone\udfff:tail',
    'toString:leaf'
  ]
  session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(keys.map((key) => [key, 'inc']))
  session.sleepingAgentSessionsByPaneKey = {}
  session.terminalSurfaceTombstonesByPaneKey = {}
  // Repeated full keys across all three records do not make a distinct suffix.
  for (const record of [
    session.sleepingAgentSessionsByPaneKey,
    session.terminalSurfaceTombstonesByPaneKey
  ]) {
    Object.defineProperty(record, 'odd:tab:a:b', {
      enumerable: true,
      get: () => {
        throw new Error('value must not be read')
      }
    })
  }
  const actual = workspaceLoader.createRecordedLeafReader(session)
  const old = oldReader(session)
  for (const query of [
    '',
    'empty',
    'odd',
    'odd:tab',
    'odd:tab:a',
    'ambiguous',
    '__proto__',
    'constructor',
    'toString',
    'unicode',
    'lone\udfff',
    'missing'
  ]) {
    expect(actual(query)).toBe(old(query))
  }
  const events: string[] = []
  for (const field of [
    'terminalPtyIncarnationsByPaneKey',
    'sleepingAgentSessionsByPaneKey',
    'terminalSurfaceTombstonesByPaneKey'
  ] as const) {
    const record = session[field]!
    Object.defineProperty(session, field, {
      get: () => {
        events.push(field)
        return new Proxy(record, {
          ownKeys: (target) => {
            events.push(`keys:${field}`)
            return Reflect.ownKeys(target)
          }
        })
      }
    })
  }
  const reader = workspaceLoader.createRecordedLeafReader(session)
  expect(events).toEqual([])
  expect(reader('empty')).toBe('')
  expect(events.slice(0, 3)).toEqual([
    'terminalPtyIncarnationsByPaneKey',
    'sleepingAgentSessionsByPaneKey',
    'terminalSurfaceTombstonesByPaneKey'
  ])
  expect(events.slice(3)).toEqual(events.slice(0, 3).map((field) => `keys:${field}`))
  reader('missing')
  expect(events).toHaveLength(6)
})

it('removes unqueried colon-prefix construction at the real missing-layout load and preserves mint/carry/save/report and rootless skips', () => {
  for (const m of [10, 100]) {
    const saved = coldInput('legacy', 1)
    saved.tabsByWorktree[GIT_KEY] = saved.tabsByWorktree[GIT_KEY].slice(0, 1)
    saved.terminalPtyIncarnationsByPaneKey = { [`x${':x'.repeat(m)}`]: 'inc' }
    const before = structuredClone(saved)
    const actualEvents: string[] = [],
      expectedEvents: string[] = []
    const context = (events: string[]) => ({
      mintId: (seed: string) => {
        events.push(`id:${seed}`)
        return seed
      },
      mintLeafId: (seed: string) => {
        events.push(`leaf:${seed}`)
        return nameBasedLoadContext().mintLeafId(seed)
      }
    })
    const candidate = loadWorkspaceLayout('local', saved, context(actualEvents))
    const oracle = vi
      .spyOn(workspaceLoader, 'createRecordedLeafReader')
      .mockImplementation(oldReader)
    let expected: ReturnType<typeof loadWorkspaceLayout>
    try {
      expected = loadWorkspaceLayout('local', structuredClone(saved), context(expectedEvents))
    } finally {
      oracle.mockRestore()
    }
    expect(candidate).toEqual(expected)
    expect(saveWorkspaceLayout(candidate)).toEqual(saveWorkspaceLayout(expected))
    expect(actualEvents).toEqual(expectedEvents)
    expect(candidate.carried.unplacedIncarnations).toEqual(saved.terminalPtyIncarnationsByPaneKey)
    expect(saved).toEqual(before)
    saved.terminalLayoutsByTabId['legacy-0'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
    const wrapped = vi.spyOn(workspaceLoader, 'createRecordedLeafReader')
    const calls = vi.fn(workspaceLoader.createRecordedLeafReader(saved))
    wrapped.mockReturnValue(calls)
    try {
      loadWorkspaceLayout('local', saved, context([]))
      expect(calls).not.toHaveBeenCalled()
    } finally {
      wrapped.mockRestore()
    }
  }
})

it('charges actual full-key acquisition, bounded sort/query characters and suffix output at N/10N', () => {
  const receipts: {
    n: number
    keyOccurrences: number
    keyCharacters: number
    characterReads: number
    prefixCharacters: number
    sliced: number
  }[] = []
  for (const n of [10, 100]) {
    const session = emptySession()
    const sourceKeys = Array.from(
      { length: n },
      (_, i) => `tab-${String(n - i).padStart(3, '0')}:leaf`
    )
    session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      sourceKeys.map((key) => [key, 'inc'])
    )
    const count = {
      n,
      keyOccurrences: 0,
      keyCharacters: 0,
      characterReads: 0,
      prefixCharacters: 0,
      sliced: 0
    }
    const keys = Object.keys,
      charCodeAt = String.prototype.charCodeAt,
      startsWith = String.prototype.startsWith,
      slice = String.prototype.slice
    const ks = vi.spyOn(Object, 'keys').mockImplementation((value) => {
      const result = keys(value)
      count.keyOccurrences += result.length
      count.keyCharacters += result.reduce((sum, key) => sum + key.length, 0)
      return result
    })
    const cs = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
      this: string,
      index
    ) {
      count.characterReads++
      return charCodeAt.call(this, index)
    })
    const ps = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
      this: string,
      prefix,
      position
    ) {
      count.prefixCharacters += prefix.length
      return startsWith.call(this, prefix, position)
    })
    const ss = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start,
      end
    ) {
      const result = slice.call(this, start, end)
      count.sliced += result.length
      return result
    })
    const results: (string | undefined)[] = []
    try {
      const reader = workspaceLoader.createRecordedLeafReader(session)
      for (let i = 1; i <= n; i++) {
        results.push(reader(`tab-${String(i).padStart(3, '0')}`))
      }
    } finally {
      for (const spy of [ks, cs, ps, ss]) {
        spy.mockRestore()
      }
    }
    expect(results).toEqual(Array.from({ length: n }, () => 'leaf'))
    expect(count.keyOccurrences).toBe(n)
    expect(count.sliced).toBe(4 * n)
    const levels = Math.ceil(Math.log2(n))
    // Each merge/query comparison reads at most both full keys; include both schedules.
    expect(count.characterReads).toBeLessThanOrEqual(4 * n * 13 * (levels + 1))
    expect(count.prefixCharacters).toBeLessThanOrEqual(2 * n * 8)
    receipts.push(count)
  }
  console.info('actual-key logical work', receipts)
  for (const m of [10, 100]) {
    const session = emptySession()
    session.terminalPtyIncarnationsByPaneKey = { [`x${':x'.repeat(m)}`]: 'inc' }
    const slice = vi.spyOn(String.prototype, 'slice')
    let calls: number
    let result: string | undefined
    try {
      result = workspaceLoader.createRecordedLeafReader(session)('short')
      calls = slice.mock.calls.length
    } finally {
      slice.mockRestore()
    }
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  }
})
