import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'
import * as memory from '@/components/native-chat/native-chat-composer-draft-memory'
import * as sources from '@/components/native-chat/native-chat-launch-draft-source'
import * as pending from '@/components/native-chat/native-chat-pending-attachment-cache'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'

afterEach(() => vi.restoreAllMocks())
import { catalogRowsEqual, reuseEqualCatalogRows } from './worktree-catalog-reconciliation'

describe('reuseEqualCatalogRows', () => {
  it('does not traverse a catalog already reconciled by identity', () => {
    const current = [
      {
        get id(): string {
          throw new Error('catalog row was traversed')
        }
      }
    ]

    expect(catalogRowsEqual(current, current)).toBe(true)
  })

  it('reuses rows with equivalent nested catalog data', () => {
    const current = [
      { id: 'a', nested: { labels: ['one', 'two'] }, optional: undefined },
      { id: 'b', nested: { labels: ['three'] } }
    ]
    const incoming = [
      { id: 'a', nested: { labels: ['one', 'two'] } },
      { id: 'b', nested: { labels: ['three'] } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).toBe(current)
    expect(catalogRowsEqual(current, incoming)).toBe(true)
  })

  it('reuses unaffected rows while publishing nested changes', () => {
    const current = [
      { id: 'a', nested: { value: 1 } },
      { id: 'b', nested: { value: 2 } }
    ]
    const incoming = [
      { id: 'a', nested: { value: 3 } },
      { id: 'b', nested: { value: 2 } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled[0]).toBe(incoming[0])
    expect(reconciled[1]).toBe(current[1])
  })

  it('does not hide host ownership changes', () => {
    const current = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-a' }]
    const incoming = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-b' }]

    expect(reuseEqualCatalogRows(current, incoming)[0]).toBe(incoming[0])
  })

  it('reuses same-ID rows from different hosts independently', () => {
    const current = [
      { id: 'repo::/same/path', hostId: 'ssh:a' },
      { id: 'repo::/same/path', hostId: 'ssh:b' }
    ]
    const equivalent = structuredClone(current)

    expect(reuseEqualCatalogRows(current, equivalent)).toBe(current)

    const incoming = structuredClone(current.toReversed())
    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled.map((row) => row.hostId)).toEqual(['ssh:b', 'ssh:a'])
    expect(reconciled[0]).toBe(current[1])
    expect(reconciled[1]).toBe(current[0])
  })

  it('reuses a match inside the duplicate-id scan window', () => {
    const current = [
      { id: 'dup', marker: 'a' },
      { id: 'dup', marker: 'b' },
      { id: 'dup', marker: 'c' }
    ]

    const reconciled = reuseEqualCatalogRows(current, [{ id: 'dup', marker: 'c' }])

    expect(reconciled[0]).toBe(current[2])
  })

  // Cap same-ID deep comparisons; count reads for deterministic O(k²) protection instead of flaky CI timing.
  it('caps the deep compares for one id instead of scanning the whole bucket', () => {
    const bucketSize = 64
    const current = Array.from({ length: bucketSize }, (_, index) => ({
      id: 'dup',
      marker: `previous-${index}`
    }))
    let reads = 0
    const incoming = [
      {
        id: 'dup',
        get marker(): string {
          reads++
          return 'matches-nothing'
        }
      }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    // No match, so the incoming row is kept — a missed reuse costs identity, never correctness.
    expect(reconciled[0]).toBe(incoming[0])
    expect(reads).toBeLessThanOrEqual(8)
    expect(reads).toBeLessThan(bucketSize)
  })
})

import * as addition from '@/components/native-chat/native-chat-composer-draft-addition'
it.each([10, 100])(
  'bounds actual populated transfer association AND hydration at H=%i',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    pending.clearNativeChatPendingAttachmentsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    const gate = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const scope = (host: string, index: number) =>
      `agent-setup:["ssh:${host}","repo::/held${index}","codex"]`
    const rich = (text: string, host: 'old' | 'new', index: number) => ({
      text,
      images: [
        { id: 'shared', path: '/shared.png' },
        { id: text, path: `/${text}.png` }
      ],
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatSkill', attrs: { token: '$review', path: `/${text}/SKILL.md` } }
            ]
          }
        ]
      },
      savedAt: 1,
      owner: { workspaceId: `repo::/held${index}`, executionHostId: `ssh:${host}` as const }
    })
    for (let index = 0; index < count; index++) {
      storage.drafts.set(scope('old', index), rich(`source${index}`, 'old', index))
      storage.drafts.set(scope('new', index), rich(`target${index}`, 'new', index))
    }
    const control = drafts.nativeChatLaunchPromptDraftScopeKey(
      'unrelated::/live',
      'claude',
      'ssh:other'
    )
    const untouched = vi.fn()
    const releaseControl = drafts.subscribeToNativeChatComposerDraft(control, untouched)
    const snapshot = new Map(storage.drafts)
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: () => gate.promise })
    const loading = drafts.hydrateNativeChatComposerDrafts()
    drafts.updateNativeChatComposerDraft(control, { text: 'unrelated input' }, 'immediate')
    untouched.mockClear()
    const store = createTestStore()
    const releases: (() => void)[] = []
    let notifications = 0
    const rows = Array.from({ length: count }, (_, index) => {
      const from = drafts.nativeChatLaunchPromptDraftScopeKey(
        `repo::/held${index}`,
        'codex',
        'ssh:old'
      )
      const to = drafts.nativeChatLaunchPromptDraftScopeKey(
        `repo::/held${index}`,
        'codex',
        'ssh:new'
      )
      if (index % 2) {
        drafts.updateNativeChatComposerDraft(from, rich(`live${index}`, 'old', index), 'immediate')
      }
      releases.push(drafts.subscribeToNativeChatComposerDraft(from, () => notifications++))
      releases.push(drafts.subscribeToNativeChatComposerDraftAppend(from, () => notifications++))
      releases.push(pending.subscribeToNativeChatPendingAttachments(from, () => notifications++))
      pending.addNativeChatPendingAttachment(from, {
        id: `pending${index}`,
        path: '',
        pending: true
      })
      const attempt = drafts.captureNativeChatComposerSubmission(from)
      return { from, to, attempt }
    })
    const counts = {
      sourceEntries: 0,
      currentEntries: 0,
      operationMembers: 0,
      recordReads: 0,
      compositions: 0,
      payloadCharacters: 0,
      writes: 0,
      updates: 0,
      removes: 0,
      persistedCharacters: 0,
      deletionPredicates: 0,
      sourceVisits: 0,
      handles: 0,
      listeners: 0,
      appends: 0,
      attempts: 0,
      checks: 0,
      pendingMoves: 0,
      chips: 0
    }
    const watch = (
      map: Map<string, Set<memory.DraftTransfer>>,
      key: 'sourceEntries' | 'currentEntries'
    ) => {
      const iterate = map[Symbol.iterator].bind(map)
      vi.spyOn(map, Symbol.iterator).mockImplementation(function* () {
        for (const entry of iterate()) {
          counts[key]++
          counts.operationMembers += entry[1].size
          yield entry
        }
      })
    }
    const countedSets = new WeakSet<Set<unknown>>()
    const watchMembers = (
      members: Set<unknown>,
      name: 'handles' | 'listeners' | 'appends' | 'attempts'
    ) => {
      if (countedSets.has(members)) {
        return
      }
      countedSets.add(members)
      const iterator = members[Symbol.iterator].bind(members),
        forEach = members.forEach.bind(members)
      vi.spyOn(members, Symbol.iterator).mockImplementation(function* () {
        for (const value of iterator()) {
          counts[name]++
          yield value
        }
      })
      vi.spyOn(members, 'forEach').mockImplementation((callback, context) => {
        counts[name] += members.size
        return forEach(callback, context)
      })
    }
    for (const [family, name] of [
      [memory.scopeListeners, 'listeners'],
      [memory.appendListeners, 'appends'],
      [memory.submissions, 'attempts']
    ] as const) {
      for (const members of family.values()) {
        watchMembers(members, name)
      }
    }
    const countedHandles = new WeakSet<Map<string, unknown>>()
    const sourcesNow = sources.launchDraftSources
    vi.spyOn(sources, 'launchDraftSources').mockImplementation(() => {
      const all = [...sourcesNow()]
      counts.sourceVisits += all.length
      for (const source of all) {
        if (countedHandles.has(source.handles)) {
          continue
        }
        countedHandles.add(source.handles)
        const iterator = source.handles[Symbol.iterator].bind(source.handles)
        vi.spyOn(source.handles, Symbol.iterator).mockImplementation(function* () {
          for (const entry of iterator()) {
            counts.handles++
            yield entry
          }
        })
      }
      return all
    })
    const checks = memory.restoredImageChecks.get.bind(memory.restoredImageChecks)
    vi.spyOn(memory.restoredImageChecks, 'get').mockImplementation((key) => {
      const held = checks(key)
      counts.checks += held?.length ?? 0
      return held
    })
    const move = pending.moveNativeChatPendingAttachments
    vi.spyOn(pending, 'moveNativeChatPendingAttachments').mockImplementation((from, to) => {
      counts.pendingMoves++
      counts.chips +=
        pending.nativeChatPendingAttachmentSnapshot(from).length +
        pending.nativeChatPendingAttachmentSnapshot(to).length
      move(from, to)
    })
    watch(memory.transferSources, 'sourceEntries')
    watch(memory.transferDestinations, 'currentEntries')
    const read = memory.records.get.bind(memory.records)
    vi.spyOn(memory.records, 'get').mockImplementation((key) => {
      counts.recordReads++
      return read(key)
    })
    const compose = addition.withIndependentNativeChatComposerDraft
    vi.spyOn(addition, 'withIndependentNativeChatComposerDraft').mockImplementation(
      (base, contribution) => {
        counts.compositions++
        counts.payloadCharacters += JSON.stringify([base, contribution]).length
        return compose(base, contribution)
      }
    )
    // Instrument the actual backend passed to production, including callback bases and resulting payloads.
    const backend = (
      await import('@/components/native-chat/native-chat-composer-draft-storage')
    ).nativeChatComposerDraftStorage()
    const write = backend.write,
      update = backend.update,
      remove = backend.remove
    vi.spyOn(backend, 'write').mockImplementation((key, value) => {
      counts.writes++
      counts.persistedCharacters += JSON.stringify(value).length
      return write(key, value)
    })
    vi.spyOn(backend, 'update').mockImplementation((key, apply) => {
      counts.updates++
      return update(key, (base) => {
        const value = apply(base)
        counts.persistedCharacters += JSON.stringify(value).length
        return value
      })
    })
    vi.spyOn(backend, 'remove').mockImplementation((keys) => {
      counts.removes += keys.length
      return remove(keys)
    })
    const loadPredicateCounter = () => {
      for (let index = 0; index < memory.load.deletionsBeforeLoad.length; index++) {
        const original = memory.load.deletionsBeforeLoad[index]
        memory.load.deletionsBeforeLoad[index] = (key, value) => {
          counts.deletionPredicates++
          return original(key, value)
        }
      }
    }
    const event = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
    notifications = 0
    store.getState().recordSshRepoReadoptions([event])
    const association = { ...counts, notifications }
    expect(memory.transferSources.size).toBe(count)
    expect(association.sourceEntries).toBe(0)
    expect(association.currentEntries).toBe(0)
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }])
    const afterChain = counts.compositions
    store.getState().recordSshRepoReadoptions([{ ...event }])
    expect(counts.compositions).toBe(afterChain)
    drafts.deleteNativeChatComposerDraft(scope('last', 0))
    loadPredicateCounter()
    drafts.updateNativeChatComposerDraft(
      scope('last', 0),
      { text: 'new explicit input' },
      'immediate'
    )
    gate.resolve(snapshot)
    await loading
    await drafts.nativeChatComposerDraftWritesSettled()
    expect(memory.transferSources.size).toBe(0)
    expect(memory.transferDestinations.size).toBe(0)
    expect(counts.sourceEntries).toBeLessThanOrEqual(2 * count)
    expect(counts.currentEntries).toBe(0)
    expect(counts.operationMembers).toBeLessThanOrEqual(2 * count)
    expect(counts.recordReads).toBeLessThanOrEqual(60 * count)
    expect(counts.deletionPredicates).toBeLessThanOrEqual(4 * count)
    expect(counts.compositions).toBeLessThanOrEqual(8 * count)
    expect(counts.payloadCharacters).toBeLessThanOrEqual(12000 * count)
    expect(counts.writes + counts.updates + counts.removes).toBeLessThanOrEqual(10 * count)
    expect(counts.persistedCharacters).toBeLessThanOrEqual(10000 * count)
    expect(untouched).not.toHaveBeenCalled()
    expect(drafts.readNativeChatComposerDraft(control).text).toBe('unrelated input')
    for (const name of [
      'sourceVisits',
      'handles',
      'listeners',
      'appends',
      'attempts',
      'checks',
      'chips'
    ] as const) {
      expect(counts[name]).toBeLessThanOrEqual(45 * count + 10)
    }
    expect(counts.pendingMoves).toBe(2 * count)
    rows.forEach((row, index) => {
      const full = drafts.readNativeChatComposerDraft(row.from)
      if (index === 0) {
        expect(full.text).toBe('new explicit input')
        expect(full.images).toHaveLength(0)
      } else {
        expect(full.text).toContain(index % 2 ? `live${index}` : `source${index}`)
        expect(full.text).toContain(`target${index}`)
        expect(full.images.filter(({ id }) => id === 'shared')).toHaveLength(1)
      }
      expect(full.owner?.executionHostId).toBe('ssh:last')
      expect(row.attempt.scopeKey).toBe(scope('last', index))
      expect(pending.nativeChatPendingAttachmentSnapshot(row.from)).toHaveLength(1)
      expect(storage.drafts.has(scope('old', index))).toBe(false)
      expect(storage.drafts.has(scope('new', index))).toBe(false)
      expect(storage.drafts.get(scope('last', index))).toEqual(full)
    })
    process.stdout.write(
      `${JSON.stringify({ metric: 'populated-transfer-complete-batches', count, association, complete: { ...counts, notifications } })}\n`
    )
    releaseControl()
    releases.forEach((release) => release())
    vi.restoreAllMocks()
    pending.clearNativeChatPendingAttachmentsForTests()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
