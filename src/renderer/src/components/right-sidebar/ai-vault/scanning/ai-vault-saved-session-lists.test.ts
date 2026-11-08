import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

const store = vi.hoisted(() => {
  const listeners = new Set<(state: { activeOrcaProfileId: string | null }) => void>()
  const state: { activeOrcaProfileId: string | null } = { activeOrcaProfileId: 'profile-1' }
  return {
    state,
    setProfile: (id: string | null) => {
      state.activeOrcaProfileId = id
      listeners.forEach((listener) => listener(state))
    },
    useAppStore: {
      getState: () => state,
      subscribe: (listener: (next: typeof state) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
})
vi.mock('@/store/index', () => ({ useAppStore: store.useAppStore }))

type Handler = (() => void) | null
type Request = { result: unknown; onsuccess: Handler; onerror: Handler }
type Transaction = {
  oncomplete: Handler
  onerror: Handler
  onabort: Handler
  error: Error | null
}

// A stand-in for the IndexedDB calls the module makes: one store, one savedAt index, commits on commit().
function fakeIndexedDb(): { puts: unknown[]; refuseNextWrite: () => void } {
  const rows = new Map<string, { savedAt: number }>()
  const puts: unknown[] = []
  let refuse = false
  const answer = (result: unknown): Request => {
    const request: Request = { result, onsuccess: null, onerror: null }
    queueMicrotask(() => request.onsuccess?.())
    return request
  }
  const database = {
    objectStoreNames: { contains: () => false },
    createObjectStore: () => ({ createIndex: () => {} }),
    transaction: () => {
      const staged = new Map(rows)
      const handlers: Transaction = { oncomplete: null, onerror: null, onabort: null, error: null }
      const transaction = Object.assign(handlers, {
        objectStore: () => ({
          get: (key: string) => answer(rows.get(key)),
          put: (value: { savedAt: number }, key: string) => {
            puts.push(value)
            staged.set(key, value)
          },
          delete: (key: string) => staged.delete(key),
          index: () => ({
            getAllKeys: () =>
              answer([...staged].sort(([, a], [, b]) => a.savedAt - b.savedAt).map(([key]) => key))
          })
        }),
        commit: () =>
          queueMicrotask(() => {
            if (refuse) {
              refuse = false
              transaction.error = new Error('quota')
              transaction.onabort?.()
              return
            }
            rows.clear()
            staged.forEach((value, key) => rows.set(key, value))
            transaction.oncomplete?.()
          })
      })
      return transaction
    }
  }
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: { result: unknown; onupgradeneeded: Handler; onsuccess: Handler } = {
        result: database,
        onupgradeneeded: null,
        onsuccess: null
      }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    }
  })
  return { puts, refuseNextWrite: () => (refuse = true) }
}

function listOf(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-07-01T00:00:00.000Z' }
}

function session(id: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-01T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [
      { role: 'user', text: 'opening ask', timestamp: null },
      { role: 'assistant', text: 'latest reply', timestamp: null }
    ],
    firstUserPrompt: 'opening ask',
    lastUserPrompt: 'opening ask',
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

async function loadModule() {
  vi.resetModules()
  return import('./ai-vault-saved-session-lists')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  store.state.activeOrcaProfileId = 'profile-1'
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('saved Session History lists', () => {
  it('keeps only the latest turn of each row and skips a rescan that changed nothing', async () => {
    const { puts } = fakeIndexedDb()
    const lists = await loadModule()
    const result = listOf([session('a')])

    await lists.saveAiVaultSessionList('workspace', 250, result)
    await lists.saveAiVaultSessionList('workspace', 250, { ...result })
    // A remount or a return to the scope rescans into fresh copies of the same rows.
    await lists.saveAiVaultSessionList('workspace', 250, listOf([session('a')]))

    expect(puts).toHaveLength(1)
    const saved = await lists.readSavedAiVaultSessionList('workspace')
    expect(saved?.limit).toBe(250)
    expect(saved?.result.sessions).toEqual([
      expect.objectContaining({
        id: 'a',
        previewMessages: [{ role: 'assistant', text: 'latest reply', timestamp: null }],
        previewMessagesTruncated: true
      })
    ])
    expect(saved?.result.sessions[0]).not.toHaveProperty('firstUserPrompt')
    expect(saved?.result.sessions[0]).not.toHaveProperty('lastUserPrompt')
  })

  it('writes the same rows again after a refused write', async () => {
    const { puts, refuseNextWrite } = fakeIndexedDb()
    const lists = await loadModule()
    const result = listOf([session('a')])

    refuseNextWrite()
    await lists.saveAiVaultSessionList('workspace', 250, result)
    expect(await lists.readSavedAiVaultSessionList('workspace')).toBeNull()

    await lists.saveAiVaultSessionList('workspace', 250, result)
    expect(puts).toHaveLength(2)
    expect(await lists.readSavedAiVaultSessionList('workspace')).not.toBeNull()
  })

  it('writes the same rows again once newer lists pushed them out', async () => {
    const { puts } = fakeIndexedDb()
    const lists = await loadModule()
    const result = listOf([session('a')])

    await lists.saveAiVaultSessionList('workspace', 250, result)
    for (let index = 0; index < 8; index++) {
      vi.setSystemTime(Date.now() + 1)
      await lists.saveAiVaultSessionList(`other-${index}`, 250, listOf([]))
    }
    expect(await lists.readSavedAiVaultSessionList('workspace')).toBeNull()

    await lists.saveAiVaultSessionList('workspace', 250, result)
    expect(puts).toHaveLength(10)
    expect(await lists.readSavedAiVaultSessionList('workspace')).not.toBeNull()
  })

  it('saves and reads once startup has loaded the profile', async () => {
    fakeIndexedDb()
    const lists = await loadModule()
    store.state.activeOrcaProfileId = null
    const save = lists.saveAiVaultSessionList('workspace', 250, listOf([session('a')]))
    store.setProfile('profile-1')
    await save
    store.state.activeOrcaProfileId = null

    const read = lists.readSavedAiVaultSessionList('workspace')
    store.setProfile('profile-1')

    expect((await read)?.result.sessions.map((row) => row.id)).toEqual(['a'])
  })

  it('keeps a list shown again without changes over lists last shown before it', async () => {
    fakeIndexedDb()
    const lists = await loadModule()
    const result = listOf([session('a')])
    await lists.saveAiVaultSessionList('workspace', 250, result)
    for (let index = 0; index < 7; index++) {
      vi.setSystemTime(Date.now() + 1)
      await lists.saveAiVaultSessionList(`other-${index}`, 250, listOf([]))
    }

    await lists.saveAiVaultSessionList('workspace', 250, result)
    vi.setSystemTime(Date.now() + 1)
    await lists.saveAiVaultSessionList('newest', 250, listOf([]))

    expect(await lists.readSavedAiVaultSessionList('workspace')).not.toBeNull()
    expect(await lists.readSavedAiVaultSessionList('other-0')).toBeNull()
  })
})
