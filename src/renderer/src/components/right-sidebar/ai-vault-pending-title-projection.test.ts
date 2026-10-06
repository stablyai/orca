// @vitest-environment happy-dom

import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { AiVaultPendingTitleProjection } from './ai-vault-pending-title-projection'
import { publishAiVaultSavedTitle } from './ai-vault-session-result-cache'
import { result, session } from './ai-vault-structured-title-fixtures'
import {
  useAiVaultSessionRefresh,
  resetAiVaultForcedRescanThrottleForTest
} from './ai-vault-session-refresh'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from './ai-vault-session-limit'

const initialState = useAppStore.getInitialState()
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  useAppStore.setState(initialState, true)
  resetAiVaultForcedRescanThrottleForTest()
  vi.restoreAllMocks()
})
function publish(index = 0, host: 'local' | 'runtime:paired-host' = 'local'): void {
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: 'folder-workspace',
    publicationEpoch: 'host:one',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    structuredConversationTitle: {
      agent: 'codex',
      sessionId: `native-${index}`,
      title: `Name ${index}`
    }
  }
  publishAiVaultSavedTitle(snapshot, host)
}
it('limits pending names, filters host scope, and releases request-owned publications', () => {
  const pending = new AiVaultPendingTitleProjection('local')
  cleanups.push(() => pending.stop())
  publish(0, 'runtime:paired-host')
  const row = {
    ...session(),
    structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-0' }
  }
  expect(pending.apply(result(row))).toEqual(result(row))
  for (let index = 0; index < 65; index++) {
    publish(index)
  }
  expect(pending.overflowed).toBe(true)
  expect(pending.apply(result(row)).sessions[0]?.title).toBe('Codex Chat')
  const last = { ...row, structuredSession: { ...row.structuredSession, sessionId: 'native-64' } }
  expect(pending.apply(result(last)).sessions[0]?.title).toBe('Name 64')
  pending.stop()
  publish(64)
  expect(pending.apply(result(last)).sessions[0]?.title).toBe('Codex Chat')
})
it('keeps the replayed StrictMode request owned after the cancelled first request settles', async () => {
  useAppStore.setState(initialState, true)
  const first = Promise.withResolvers<AiVaultListResult>()
  const second = Promise.withResolvers<AiVaultListResult>()
  const listSessions = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(result())
  const stop = vi.spyOn(AiVaultPendingTitleProjection.prototype, 'stop')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions,
        cancelListSessions: vi.fn().mockResolvedValue(undefined),
        onWindowFocused: () => () => {}
      }
    }
  })
  let refresh: ReturnType<typeof useAiVaultSessionRefresh> | undefined
  function Probe(): null {
    refresh = useAiVaultSessionRefresh(['/strict-folder'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT)
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))))
  expect(listSessions).toHaveBeenCalledTimes(2)
  await act(async () => first.resolve({ ...result(), cancelled: true }))
  await act(async () => {
    void refresh?.refresh({ background: true })
  })
  expect(listSessions).toHaveBeenCalledTimes(2)
  stop.mockClear()
  await act(async () => root.unmount())
  expect(stop).toHaveBeenCalledTimes(1)
  await act(async () => second.resolve(result()))
  expect(listSessions).toHaveBeenCalledTimes(2)
})
