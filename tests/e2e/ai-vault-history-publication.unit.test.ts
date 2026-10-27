// @vitest-environment happy-dom
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createSqliteTestStore,
  writePersistedStateJson
} from '../../src/main/persistence/persistence-test-harness'
import { Store } from '../../src/main/persistence/loading-store/store'
import { getDefaultPersistedState } from '../../src/shared/constants'
import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'
import { sessionSearchScopeCatalogFromStore } from '../../src/main/ai-vault-search/session-search-store-scope-catalog'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  AI_VAULT_METHODS,
  AiVaultListSessionsParams
} from '../../src/main/runtime/rpc/methods/ai-vault'
import {
  configureAiVaultSessionSources,
  resetAiVaultSessionListCacheForTests
} from '../../src/main/ai-vault/cached-session-list'
import * as ownership from '../../src/main/ai-vault-search/session-search-project-ownership'
import * as fingerprints from '../../src/main/ai-vault/session-list-fingerprint'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../src/shared/ai-vault-types'
import * as equality from '../../src/shared/structural-value-equality'
import * as identity from '../../src/renderer/src/components/right-sidebar/ai-vault-session-identity'
import {
  useAiVaultSessionRefresh,
  resetAiVaultForcedRescanThrottleForTest
} from '../../src/renderer/src/components/right-sidebar/ai-vault-session-refresh'
import { resetInputQuietSchedulerForTest } from '../../src/renderer/src/lib/input-quiet-scheduler'
import { useAppStore } from '../../src/renderer/src/store'
import { aiVaultSearchHitToSession } from '../../src/renderer/src/components/right-sidebar/ai-vault-search-session'
import { searchHit } from '../../src/shared/ai-vault-search-test-fixture'

const { scan } = vi.hoisted(() => ({ scan: vi.fn<() => Promise<AiVaultListResult>>() }))
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof crypto>()
  return { ...actual, createHash: vi.fn(actual.createHash) }
})
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path
}))
vi.mock('../../src/main/ai-vault/session-scanner-service-spawn', async (original) => ({
  ...(await original<object>()),
  scanAiVaultSessionsInService: scan
}))
vi.mock('../../src/main/claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))
vi.mock('../../src/main/ai-vault/opencode-wsl-runtime-preparation', () => ({
  prepareOpenCodeWslReaders: async () => []
}))

function transcript(index: number): AiVaultSession {
  return {
    ...aiVaultSearchHitToSession(
      { ...searchHit(), sessionId: `session-${index}`, cwd: '/retained' },
      'local'
    ),
    previewMessages: [
      { role: 'user', text: `question-${index}`, timestamp: null },
      { role: 'assistant', text: `answer-${index}`, timestamp: null }
    ]
  }
}

async function mountedHistory(count: number) {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetAiVaultForcedRescanThrottleForTest()
  resetInputQuietSchedulerForTest()
  resetAiVaultSessionListCacheForTests()
  const initial = useAppStore.getInitialState()
  useAppStore.setState(initial, true)
  const directory = await fs.mkdtemp(join(tmpdir(), 'sta10541-publication-'))
  const dataFile = join(directory, 'state.json')
  const state = getDefaultPersistedState(directory)
  state.repos = ['a', 'b', 'c'].map((id, index) => ({
    id,
    path: `/clones/${id}`,
    addedAt: index + 1,
    displayName: id,
    badgeColor: ''
  }))
  writePersistedStateJson(dataFile, JSON.stringify(state))
  const store = createSqliteTestStore(Store, { dataFile })
  const target = hostWorktreeTarget({ id: 'a::/retained', hostId: 'local' })
  const setOwner = (owner: string) =>
    store.setWorktreeMeta(target, {
      projectId: owner,
      projectHostSetupId: owner.slice('repo:'.length)
    })
  setOwner('repo:a')
  const capture = vi.fn(() => sessionSearchScopeCatalogFromStore(store, 'local'))
  scan.mockResolvedValue({
    sessions: Array.from({ length: count }, (_, index) => transcript(index)),
    issues: [],
    scannedAt: 'same-scan'
  })
  const compile = vi.spyOn(ownership, 'compileSessionSearchProjectOwnership')
  const reconcile = vi.spyOn(identity, 'reuseAiVaultListResult')
  const compare = vi.spyOn(equality, 'structuralValuesEqualIgnoringUndefined')
  const hashes = vi.mocked(crypto.createHash)
  let listHashCalls = 0
  const finalize = fingerprints.conditionalAiVaultListResult
  const conditional = vi
    .spyOn(fingerprints, 'conditionalAiVaultListResult')
    .mockImplementation((...args) => {
      const before = hashes.mock.calls.length
      const result = finalize(...args)
      listHashCalls += hashes.mock.calls.length - before
      return result
    })
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  configureAiVaultSessionSources({ getProjectOwnershipCatalog: capture })
  hashes.mockClear()
  const method = AI_VAULT_METHODS.find((entry) => entry.name === 'aiVault.listSessions')
  if (!method) {
    throw new Error('Missing History RPC')
  }
  const outputs: AiVaultListResult[] = []
  let payloadReads = 0
  const api = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions: async (args: AiVaultListArgs) => {
          const params = AiVaultListSessionsParams.parse({
            ...args,
            executionHostId: 'runtime:one'
          })
          // The real handler performs structured projection, runtime restamping and conditional transfer.
          const result = structuredClone(await method.handler(params, { runtime }))
          outputs.push(result)
          // Observe nested reads by the real comparator after the transport clone.
          for (const row of result.sessions) {
            for (const message of row.previewMessages) {
              const text = message.text
              Object.defineProperty(message, 'text', {
                enumerable: true,
                get: () => {
                  payloadReads += 1
                  return text
                }
              })
            }
          }
          return result
        },
        cancelListSessions: async () => {},
        onWindowFocused: () => () => {}
      }
    }
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
  function Probe({ limit }: { limit: number | 'unlimited' }) {
    latest = useAiVaultSessionRefresh([], 'runtime:one', limit)
    return null
  }
  const settle = async () => {
    await act(async () => vi.advanceTimersByTimeAsync(1200))
  }
  return {
    capture,
    compile,
    reconcile,
    compare,
    conditional,
    listHashCalls: () => listHashCalls,
    outputs,
    payloadReads: () => payloadReads,
    setOwner,
    current: () => {
      if (!latest) {
        throw new Error('History is not mounted')
      }
      return latest
    },
    mount: async (limit: number | 'unlimited' = 'unlimited') => {
      await act(async () => root.render(createElement(Probe, { limit })))
      await settle()
    },
    refresh: async () => {
      await act(async () => latest?.refresh({ background: true }))
      await settle()
    },
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
      if (api) {
        Object.defineProperty(window, 'api', api)
      } else {
        Reflect.deleteProperty(window, 'api')
      }
      useAppStore.setState(initial, true)
      resetAiVaultSessionListCacheForTests()
      configureAiVaultSessionSources({})
      resetAiVaultForcedRescanThrottleForTest()
      resetInputQuietSchedulerForTest()
      scan.mockReset()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
      await closeTestStores()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

it('publishes post-cache ownership at an unchanged stamp through Unlimited RPC and keeps nested unchanged identities', async () => {
  const history = await mountedHistory(1)
  try {
    await history.mount()
    expect(history.current().sessions[0].projectOwnerKey).toBe('repo:a')
    history.setOwner('repo:b')
    await history.refresh()
    expect(history.outputs.at(-1)?.sessions[0].projectOwnerKey).toBe('repo:b')
    expect(history.outputs.at(-1)?.scannedAt).toBe(history.outputs[0].scannedAt)
    expect(history.outputs.at(-1)?.fingerprint).toBeUndefined()
    expect(history.current().sessions[0].projectOwnerKey).toBe('repo:b')
    expect(history.current().sessions[0].executionHostId).toBe('runtime:one')
    expect(scan).toHaveBeenCalledTimes(1)
    const applied = history.current().scanResult
    const sessions = history.current().sessions
    const row = sessions[0]
    await history.refresh()
    expect(history.outputs.at(-1)?.sessions[0].previewMessages).not.toBe(row.previewMessages)
    expect(history.current().scanResult).toBe(applied)
    expect(history.current().sessions).toBe(sessions)
    expect(history.current().sessions[0]).toBe(row)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(history.capture).toHaveBeenCalledTimes(3)
    expect(history.compile).toHaveBeenCalledTimes(3)
    expect(history.listHashCalls()).toBe(0)
    expect(history.conditional.mock.calls.every(([, after]) => after === undefined)).toBe(true)

    await history.mount(250)
    expect(history.listHashCalls()).toBe(1)
    history.setOwner('repo:c')
    await history.refresh()
    expect(history.outputs.at(-1)?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(history.current().sessions[0].projectOwnerKey).toBe('repo:c')
    expect(history.listHashCalls()).toBe(2)
  } finally {
    await history.close()
  }
})

it.each([20, 200])(
  'bounds repeated actual full refresh work for %i unique nested rows',
  async (count) => {
    const history = await mountedHistory(count)
    try {
      await history.mount()
      const applied = history.current().scanResult
      const sessions = history.current().sessions
      const before = history.payloadReads()
      history.reconcile.mockClear()
      history.compare.mockClear()
      for (let repeat = 0; repeat < 3; repeat++) {
        await history.refresh()
        expect(history.current().scanResult).toBe(applied)
        expect(history.current().sessions).toBe(sessions)
        expect(history.current().sessions.every((row, index) => row === sessions[index])).toBe(true)
      }
      expect(history.outputs).toHaveLength(4)
      expect(history.reconcile).toHaveBeenCalledTimes(3)
      expect(history.compare).toHaveBeenCalledTimes(3 * count)
      expect(history.payloadReads() - before).toBe(3 * count * 4)
      expect(history.capture).toHaveBeenCalledTimes(4)
      expect(history.compile).toHaveBeenCalledTimes(4)
      expect(history.listHashCalls()).toBe(0)
      expect(history.conditional).toHaveBeenCalledTimes(4)
      expect(history.conditional.mock.calls.every(([, after]) => after === undefined)).toBe(true)
      expect(history.outputs.every((result) => result.fingerprint === undefined)).toBe(true)
      expect(scan).toHaveBeenCalledTimes(1)
    } finally {
      await history.close()
    }
  }
)
