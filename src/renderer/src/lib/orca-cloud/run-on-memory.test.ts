import { describe, expect, it } from 'vitest'
import { readRunOnMemory, recordSuccessfulRunOn, setRunOnPreference } from './run-on-memory'
import {
  CLOUD_START_DRAFT_MAX_AGE_MS,
  clearCloudStartDraft,
  readCloudStartDraft,
  saveCloudStartDraft
} from './cloud-start-draft'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value)
  }
}

describe('run-on memory', () => {
  it('remembers only what was recorded after a successful start, per project and profile', () => {
    const storage = memoryStorage()
    expect(readRunOnMemory('p1', 'repo-a', storage)).toEqual({
      preference: 'last',
      lastForRepo: null,
      globalLast: null
    })
    recordSuccessfulRunOn('p1', 'repo-a', 'orca-cloud', storage)
    expect(readRunOnMemory('p1', 'repo-a', storage)).toMatchObject({
      lastForRepo: 'orca-cloud',
      globalLast: 'orca-cloud'
    })
    expect(readRunOnMemory('p1', 'repo-b', storage)).toMatchObject({
      lastForRepo: null,
      globalLast: 'orca-cloud'
    })
    // Another profile never sees it.
    expect(readRunOnMemory('p2', 'repo-a', storage).lastForRepo).toBeNull()
  })

  it('stores the "Default run on" project setting; "last" clears it', () => {
    const storage = memoryStorage()
    setRunOnPreference('p1', 'repo-a', 'local', storage)
    expect(readRunOnMemory('p1', 'repo-a', storage).preference).toBe('local')
    setRunOnPreference('p1', 'repo-a', 'last', storage)
    expect(readRunOnMemory('p1', 'repo-a', storage).preference).toBe('last')
  })

  it('ignores corrupt records', () => {
    const storage = memoryStorage()
    storage.setItem('orca.runOn.v1:p1', '{"lastByRepo":{"r":"mars"},"globalLast":7}')
    expect(readRunOnMemory('p1', 'r', storage)).toEqual({
      preference: 'last',
      lastForRepo: null,
      globalLast: null
    })
  })
})

describe('cloud start draft', () => {
  it('round-trips per profile and expires after 30 minutes', () => {
    const storage = memoryStorage()
    const draft = {
      prompt: 'Fix the flaky login test',
      repoId: 'repo-a',
      agent: 'claude',
      target: 'orca-cloud' as const,
      setupSessionId: null,
      createdAt: 1_000
    }
    saveCloudStartDraft('p1', draft, storage)
    expect(readCloudStartDraft('p1', 2_000, storage)).toEqual(draft)
    expect(readCloudStartDraft('p2', 2_000, storage)).toBeNull()
    expect(readCloudStartDraft('p1', 1_000 + CLOUD_START_DRAFT_MAX_AGE_MS + 1, storage)).toBeNull()
    // Expired drafts are removed.
    expect(storage.getItem('orca.cloudStart.draft.v1:p1')).toBeNull()
  })

  it('is cleared on a successful create', () => {
    const storage = memoryStorage()
    saveCloudStartDraft(
      'p1',
      {
        prompt: 'x',
        repoId: 'r',
        agent: null,
        target: 'orca-cloud',
        setupSessionId: 's1',
        createdAt: 5
      },
      storage
    )
    clearCloudStartDraft('p1', storage)
    expect(readCloudStartDraft('p1', 6, storage)).toBeNull()
  })
})
