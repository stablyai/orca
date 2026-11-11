import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { readRecordChanges } from '@/store/keyed-record-change-reads'

type Records = Readonly<Record<string, SleepingAgentSessionRecord | undefined>>
type RecordEntry = readonly [string, SleepingAgentSessionRecord]
const EMPTY_ENTRIES: readonly RecordEntry[] = []

function providerSessionKey(record: SleepingAgentSessionRecord): string | null {
  return record.providerSession
    ? JSON.stringify([record.agent, record.providerSession.key, record.providerSession.id])
    : null
}

function tabPrefixes(key: string, record: SleepingAgentSessionRecord | undefined): Set<string> {
  const ids = new Set(record?.tabId === undefined ? [] : [record.tabId])
  for (let colon = key.indexOf(':'); colon !== -1; colon = key.indexOf(':', colon + 1)) {
    ids.add(key.slice(0, colon))
  }
  return ids
}

function resyncSleepingAgentRecordKeys(records: Records): string[] {
  return Object.keys(records)
}

function diffUnknownSleepingRecordKeys(previous: Records | null, next: Records): Set<string> {
  return new Set([...Object.keys(previous ?? {}), ...Object.keys(next)])
}

export function createSleepingAgentRecordIndex() {
  let source: Records | null = null
  const orderByKey = new Map<string, number>()
  let nextOrder = 0
  const entriesByWorktree = new Map<string, Map<string, SleepingAgentSessionRecord>>()
  const snapshotsByWorktree = new Map<string, readonly RecordEntry[]>()
  const keysByTabPrefix = new Map<string, Set<string>>()
  const recordsByProviderSession = new Map<string, Map<string, SleepingAgentSessionRecord>>()

  function update(records: Records): void {
    if (records === source) {
      return
    }
    const previous = source
    const dirty = new Set<string>()
    const changes = previous ? readRecordChanges(records, previous) : null
    const keys = changes?.kind === 'addressed' ? changes.keys : null
    // Bootstrap, hydration or an unknown replacement has no trusted partial change list.
    if (keys === null) {
      for (const id of entriesByWorktree.keys()) {
        dirty.add(id)
      }
      orderByKey.clear()
      nextOrder = 0
      entriesByWorktree.clear()
      snapshotsByWorktree.clear()
      keysByTabPrefix.clear()
      recordsByProviderSession.clear()
    }
    if (changes?.kind === 'addressed') {
      for (const key of changes.added) {
        orderByKey.set(key, nextOrder++)
      }
    }
    const changedKeys = keys ?? resyncSleepingAgentRecordKeys(records)
    for (const key of changedKeys) {
      const before = keys ? previous?.[key] : undefined
      const after = records[key]
      const beforePresent = keys !== null && previous !== null && Object.hasOwn(previous, key)
      const afterPresent = Object.hasOwn(records, key)
      if (before === after && beforePresent === afterPresent) {
        continue
      }
      if (!afterPresent) {
        orderByKey.delete(key)
      } else if (!orderByKey.has(key)) {
        orderByKey.set(key, nextOrder++)
      }
      if (beforePresent) {
        for (const tabId of tabPrefixes(key, before)) {
          const owned = keysByTabPrefix.get(tabId)
          owned?.delete(key)
          if (owned?.size === 0) {
            keysByTabPrefix.delete(tabId)
          }
        }
      }
      if (afterPresent) {
        for (const tabId of tabPrefixes(key, after)) {
          let owned = keysByTabPrefix.get(tabId)
          if (!owned) {
            keysByTabPrefix.set(tabId, (owned = new Set()))
          }
          owned.add(key)
        }
      }
      if (before) {
        const sessionKey = providerSessionKey(before)
        if (sessionKey && (!after || providerSessionKey(after) !== sessionKey)) {
          const bucket = recordsByProviderSession.get(sessionKey)
          bucket?.delete(key)
          if (bucket?.size === 0) {
            recordsByProviderSession.delete(sessionKey)
          }
        }
        if (after?.worktreeId !== before.worktreeId) {
          entriesByWorktree.get(before.worktreeId)?.delete(key)
        }
        dirty.add(before.worktreeId)
      }
      if (after) {
        const sessionKey = providerSessionKey(after)
        if (sessionKey) {
          let bucket = recordsByProviderSession.get(sessionKey)
          if (!bucket) {
            recordsByProviderSession.set(sessionKey, (bucket = new Map()))
          }
          bucket.set(key, after)
        }
        let bucket = entriesByWorktree.get(after.worktreeId)
        if (!bucket) {
          entriesByWorktree.set(after.worktreeId, (bucket = new Map()))
        }
        bucket.set(key, after)
        dirty.add(after.worktreeId)
      }
    }
    for (const worktreeId of dirty) {
      const bucket = entriesByWorktree.get(worktreeId)
      if (bucket?.size) {
        snapshotsByWorktree.set(
          worktreeId,
          [...bucket].sort(([a], [b]) => {
            const indexA = Number(a)
            const indexB = Number(b)
            const numericA =
              Number.isInteger(indexA) && indexA >= 0 && indexA < 4294967295 && String(indexA) === a
            const numericB =
              Number.isInteger(indexB) && indexB >= 0 && indexB < 4294967295 && String(indexB) === b
            if (numericA || numericB) {
              return numericA && numericB ? indexA - indexB : numericA ? -1 : 1
            }
            return orderByKey.get(a)! - orderByKey.get(b)!
          })
        )
      } else {
        entriesByWorktree.delete(worktreeId)
        snapshotsByWorktree.delete(worktreeId)
      }
    }
    source = records
  }

  return {
    update,
    acceptTransition(previous: Records | null, next: Records) {
      const worktreeIds = new Set<string>()
      const tabIds = new Set<string>()
      const changes = previous ? readRecordChanges(next, previous) : null
      const keys = changes?.kind === 'addressed' ? changes.keys : previous === next ? [] : null
      const changedKeys = keys ?? diffUnknownSleepingRecordKeys(previous, next)
      for (const key of changedKeys) {
        const before = previous?.[key]
        const after = next[key]
        const beforePresent = previous !== null && Object.hasOwn(previous, key)
        const afterPresent = Object.hasOwn(next, key)
        if (before === after && beforePresent === afterPresent) {
          continue
        }
        if (beforePresent || afterPresent) {
          for (const tabId of tabPrefixes(key, undefined)) {
            tabIds.add(tabId)
          }
        }
        for (const record of [before, after]) {
          if (!record) {
            continue
          }
          worktreeIds.add(record.worktreeId)
          for (const tabId of tabPrefixes(key, record)) {
            tabIds.add(tabId)
          }
        }
      }
      update(next)
      return { worktreeIds, tabIds }
    },
    entries(records: Records, worktreeId: string): readonly RecordEntry[] {
      update(records)
      return snapshotsByWorktree.get(worktreeId) ?? EMPTY_ENTRIES
    },
    hasTabPrefix(records: Records, tabId: string): boolean {
      update(records)
      return keysByTabPrefix.has(tabId)
    },
    providerSessionCandidates(
      records: Records,
      record: SleepingAgentSessionRecord
    ): Iterable<SleepingAgentSessionRecord> {
      update(records)
      const key = providerSessionKey(record)
      return (key ? recordsByProviderSession.get(key)?.values() : undefined) ?? []
    },
    worktreeIds(records: Records): Iterable<string> {
      update(records)
      return entriesByWorktree.keys()
    }
  }
}

export const sleepingAgentRecordIndex = createSleepingAgentRecordIndex()
