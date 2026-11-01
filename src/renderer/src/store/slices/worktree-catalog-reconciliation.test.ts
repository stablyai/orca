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
import * as journal from '@/components/native-chat/native-chat-composer-draft-journal'
it.each([10, 100])(
  'bounds current-memory setup association, chain/replay/recovery/deletion beside ordinary hydration at N=%i',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    pending.clearNativeChatPendingAttachmentsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    const gate = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const scope = (host: string, index: number) =>
      `agent-setup:["ssh:${host}","repo::/held${index}","codex"]`
    const rich = (text: string) => ({
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
              { type: 'nativeChatSkill', attrs: { token: '$same', path: `/${text}/SKILL.md` } }
            ]
          }
        ]
      },
      savedAt: 1
    })
    for (let i = 0; i < count; i++) {
      storage.drafts.set(scope('old', i), rich(`residue${i}`))
      storage.drafts.set(scope('new', i), rich(`other-residue${i}`))
      storage.drafts.set(`agent-session:ordinary${i}`, rich(`ordinary${i}`))
    }
    const counts = {
      loadedEntries: 0,
      loadedBytes: 0,
      recordReads: 0,
      sourceVisits: 0,
      handles: 0,
      listeners: 0,
      appends: 0,
      attempts: 0,
      checks: 0,
      imageVisits: 0,
      blockVisits: 0,
      compositions: 0,
      inputCharacters: 0,
      writes: 0,
      updates: 0,
      removes: 0,
      serializedCharacters: 0,
      fullJournalEntries: 0,
      additionJournalEntries: 0,
      predicates: 0,
      notifications: 0,
      pendingMoves: 0,
      chips: 0
    }
    const snapshot = new Map(storage.drafts)
    const iterate = snapshot[Symbol.iterator].bind(snapshot)
    vi.spyOn(snapshot, Symbol.iterator).mockImplementation(function* () {
      for (const entry of iterate()) {
        counts.loadedEntries++
        counts.loadedBytes += JSON.stringify(entry[1]).length
        yield entry
      }
      return undefined
    })
    const write = vi.fn(storage.write),
      update = vi.fn(storage.update),
      remove = vi.fn(storage.remove)
    setNativeChatComposerDraftStorageForTests({
      ...storage,
      loadAll: () => gate.promise,
      write: (key, value) => {
        counts.writes++
        counts.serializedCharacters += JSON.stringify(value).length
        return write(key, value)
      },
      update: (key, apply) => {
        counts.updates++
        return update(key, apply)
      },
      remove: (keys) => {
        counts.removes += keys.length
        return remove(keys)
      }
    })
    const loading = drafts.hydrateNativeChatComposerDrafts()
    const store = createTestStore()
    const control = drafts.nativeChatLaunchPromptDraftScopeKey(
      'unrelated::/live',
      'claude',
      'ssh:other'
    )
    drafts.updateNativeChatComposerDraft(control, { text: 'unrelated input' }, 'immediate')
    const untouched = vi.fn(),
      releaseControl = drafts.subscribeToNativeChatComposerDraft(control, untouched)
    const releases: (() => void)[] = []
    const rows = Array.from({ length: count }, (_, i) => {
      const from = drafts.nativeChatLaunchPromptDraftScopeKey(`repo::/held${i}`, 'codex', 'ssh:old')
      const to = drafts.nativeChatLaunchPromptDraftScopeKey(`repo::/held${i}`, 'codex', 'ssh:new')
      drafts.updateNativeChatComposerDraft(from, rich(`source${i}`), 'immediate')
      drafts.updateNativeChatComposerDraft(to, rich(`target${i}`), 'immediate')
      const attempt = drafts.captureNativeChatComposerSubmission(from)
      if (i % 2 === 0) {
        drafts.updateNativeChatComposerDraft(from, { text: '', images: [] }, 'immediate')
      }
      releases.push(drafts.subscribeToNativeChatComposerDraft(from, () => counts.notifications++))
      releases.push(
        drafts.subscribeToNativeChatComposerDraftAppend(from, () => counts.notifications++)
      )
      releases.push(
        pending.subscribeToNativeChatPendingAttachments(from, () => counts.notifications++)
      )
      pending.addNativeChatPendingAttachment(from, { id: `pending${i}`, path: '', pending: true })
      return { from, to, attempt }
    })
    const arrays = new WeakSet<object>()
    const watchArray = <T>(array: readonly T[], name: 'imageVisits' | 'blockVisits' | 'checks') => {
      if (arrays.has(array)) {
        return
      }
      arrays.add(array)
      const iterator = array[Symbol.iterator].bind(array),
        map = array.map.bind(array),
        filter = array.filter.bind(array)
      vi.spyOn(array, Symbol.iterator).mockImplementation(function* () {
        for (const item of iterator()) {
          counts[name]++
          yield item
        }
        return undefined
      })
      vi.spyOn(array, 'map').mockImplementation((callback, context) => {
        counts[name] += array.length
        return map(callback, context)
      })
      vi.spyOn(array, 'filter').mockImplementation((callback, context) => {
        counts[name] += array.length
        return filter(callback, context)
      })
    }
    const watchRecord = (draft: memory.DraftRecord) => {
      watchArray(draft.images, 'imageVisits')
      if (draft.document?.content) {
        watchArray(draft.document.content, 'blockVisits')
      }
    }
    for (const record of memory.records.values()) {
      watchRecord(record)
    }
    for (const row of rows) {
      if (row.attempt.draft) {
        watchRecord({ ...row.attempt.draft, savedAt: 0 })
      }
    }
    const set = memory.records.set.bind(memory.records)
    vi.spyOn(memory.records, 'set').mockImplementation((key, value) => {
      watchRecord(value)
      return set(key, value)
    })
    for (const checks of memory.restoredImageChecks.values()) {
      watchArray(checks, 'checks')
    }
    const read = memory.records.get.bind(memory.records)
    vi.spyOn(memory.records, 'get').mockImplementation((key) => {
      counts.recordReads++
      return read(key)
    })
    const watchMembers = <T>(members: Set<T>, name: 'listeners' | 'appends' | 'attempts') => {
      const iterate = members[Symbol.iterator].bind(members),
        each = members.forEach.bind(members)
      vi.spyOn(members, Symbol.iterator).mockImplementation(function* () {
        for (const member of iterate()) {
          counts[name]++
          yield member
        }
        return undefined
      })
      vi.spyOn(members, 'forEach').mockImplementation((callback, context) => {
        counts[name] += members.size
        return each(callback, context)
      })
    }
    for (const members of memory.scopeListeners.values()) {
      watchMembers(members, 'listeners')
    }
    for (const members of memory.appendListeners.values()) {
      watchMembers(members, 'appends')
    }
    for (const members of memory.submissions.values()) {
      watchMembers(members, 'attempts')
    }
    const sourcesNow = sources.launchDraftSources
    vi.spyOn(sources, 'launchDraftSources').mockImplementation(() => {
      const all = [...sourcesNow()]
      counts.sourceVisits += all.length
      return all
    })
    for (const source of sourcesNow()) {
      const iterate = source.handles[Symbol.iterator].bind(source.handles)
      vi.spyOn(source.handles, Symbol.iterator).mockImplementation(function* () {
        for (const entry of iterate()) {
          counts.handles++
          yield entry
        }
        return undefined
      })
    }
    const compose = addition.withIndependentNativeChatComposerDraft
    vi.spyOn(addition, 'withIndependentNativeChatComposerDraft').mockImplementation(
      (base, contribution) => {
        counts.compositions++
        counts.inputCharacters += base.text.length + (contribution.text?.length ?? 0)
        return compose(base, contribution)
      }
    )
    const full = journal.journalNativeChatComposerDraftChanges,
      append = journal.journalNativeChatComposerDraftAddition
    vi.spyOn(journal, 'journalNativeChatComposerDraftChanges').mockImplementation((entries) => {
      counts.fullJournalEntries += entries.size
      return full(entries)
    })
    vi.spyOn(journal, 'journalNativeChatComposerDraftAddition').mockImplementation((...args) => {
      counts.additionJournalEntries++
      return append(...args)
    })
    const move = pending.moveNativeChatPendingAttachments
    vi.spyOn(pending, 'moveNativeChatPendingAttachments').mockImplementation((from, to) => {
      counts.pendingMoves++
      counts.chips +=
        pending.nativeChatPendingAttachmentSnapshot(from).length +
        pending.nativeChatPendingAttachmentSnapshot(to).length
      move(from, to)
    })
    counts.notifications = 0
    const event = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
    store.getState().recordSshRepoReadoptions([event])
    const association = { ...counts }
    expect(association.compositions).toBe(count / 2)
    expect(association.writes + association.updates + association.removes).toBe(0)
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }])
    const chained = counts.compositions
    store.getState().recordSshRepoReadoptions([{ ...event }])
    expect(counts.compositions).toBe(chained)
    drafts.deleteNativeChatComposerDraft(rows[0].from)
    drafts.updateNativeChatComposerDraft(rows[0].from, { text: 'new explicit input' }, 'immediate')
    for (let i = 0; i < rows.length; i++) {
      drafts.finishNativeChatComposerSubmission(rows[i].from, rows[i].attempt, i % 2 === 0)
    }
    for (let i = 0; i < memory.load.deletionsBeforeLoad.length; i++) {
      const matches = memory.load.deletionsBeforeLoad[i]
      memory.load.deletionsBeforeLoad[i] = (key, value) => {
        counts.predicates++
        return matches(key, value)
      }
    }
    const beforeHydration = { ...counts }
    gate.resolve(snapshot)
    await loading
    await drafts.nativeChatComposerDraftWritesSettled()
    expect(counts.loadedEntries).toBe(3 * count)
    expect(counts.loadedBytes).toBeGreaterThan(0)
    expect(counts.compositions).toBe(beforeHydration.compositions)
    expect(counts.writes + counts.updates).toBe(0)
    expect(counts.removes).toBe(1)
    expect(counts.serializedCharacters).toBe(0)
    expect(counts.fullJournalEntries + counts.additionJournalEntries).toBe(0)
    expect(counts.predicates).toBe(count)
    for (let i = 0; i < count; i++) {
      const current = drafts.readNativeChatComposerDraft(rows[i].from)
      expect(current.text).toBe(i === 0 ? 'new explicit input' : `target${i}\n\nsource${i}`)
      expect(current.images.map(({ id }) => id)).toEqual(
        i === 0 ? [] : ['shared', `target${i}`, `source${i}`]
      )
      expect(JSON.stringify(current.document ?? null)).not.toContain('residue')
      if (i > 0) {
        expect(JSON.stringify(current.document)).toContain(`/target${i}/SKILL.md`)
        expect(JSON.stringify(current.document)).toContain(`/source${i}/SKILL.md`)
      }
      expect(current.owner?.executionHostId).toBe('ssh:last')
      expect(rows[i].attempt.draft).toBeUndefined()
      expect(rows[i].attempt.scopeKey).toBe(scope('last', i))
      expect(drafts.readNativeChatComposerDraft(`agent-session:ordinary${i}`).text).toBe(
        `ordinary${i}`
      )
      expect(pending.nativeChatPendingAttachmentSnapshot(rows[i].from)).toHaveLength(1)
      expect(storage.drafts.get(scope('old', i))?.text).toBe(`residue${i}`)
      expect(storage.drafts.has(scope('last', i))).toBe(false)
    }
    expect(memory.submissions.size).toBe(0)
    expect(counts.recordReads).toBeLessThanOrEqual(40 * count + 10)
    expect(counts.compositions).toBeLessThanOrEqual(2 * count)
    expect(counts.inputCharacters).toBeLessThanOrEqual(100 * count)
    expect(counts.imageVisits).toBeGreaterThan(0)
    expect(counts.blockVisits).toBeGreaterThan(0)
    for (const name of [
      'sourceVisits',
      'handles',
      'listeners',
      'appends',
      'attempts',
      'checks',
      'imageVisits',
      'blockVisits',
      'notifications',
      'chips'
    ] as const) {
      expect(counts[name]).toBeLessThanOrEqual(100 * count + 10)
    }
    expect(counts.pendingMoves).toBe(2 * count)
    expect(untouched).not.toHaveBeenCalled()
    expect(drafts.readNativeChatComposerDraft(control).text).toBe('unrelated input')
    releases.forEach((release) => release())
    const notifications = counts.notifications
    drafts.updateNativeChatComposerDraft(rows[1].from, { text: 'later ordinary edit' }, 'immediate')
    expect(counts.notifications).toBe(notifications)
    process.stdout.write(
      `${JSON.stringify({ metric: 'memory-setup-complete-batches', count, association, beforeHydration, complete: counts })}\n`
    )
    releaseControl()
    vi.restoreAllMocks()
    pending.clearNativeChatPendingAttachmentsForTests()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
