// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanProgress } from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { aiVaultLocalScanKey } from '../../../../../../shared/ai-vault/scanning/ai-vault-local-scan-key'

import { resetAiVaultSessionResultCacheForTest } from './ai-vault-session-result-cache'
import {
  resetAiVaultScanProgressStoreForTests,
  useAiVaultScanProgress
} from './ai-vault-scan-progress-store'

afterEach(() => {
  cleanup()
  resetAiVaultScanProgressStoreForTests()
  resetAiVaultSessionResultCacheForTest()
  vi.unstubAllGlobals()
})

const FINISHED: AiVaultScanProgress = {
  scanId: 'scan-a',
  stage: 'finished',
  agents: [
    { agent: 'claude', files: 24_968, databases: 0, walking: false },
    { agent: 'codex', files: 77_483, databases: 0, walking: false },
    { agent: 'opencode', files: 0, databases: 1, walking: false }
  ],
  read: { done: 2_000, total: 2_000 },
  startedAt: 0,
  settledAt: 90_000
}

it('keeps a narrower cached panel off the broader key while a late matching panel loads it', async () => {
  const lowerDepth = { scopePaths: ['/project'], includeAntigravityIdeSessions: true, limit: 100 }
  const broader = aiVaultLocalScanKey({ ...lowerDepth, limit: 1000 })
  const narrower = aiVaultLocalScanKey(lowerDepth)
  expect(broader).not.toBe(narrower)
  const cachedProgress = FINISHED
  let push: (update: { scanKey: string; progress: AiVaultScanProgress | null }) => void = () =>
    undefined
  vi.stubGlobal('api', {
    aiVault: {
      getScanProgress: (scanKey: string) =>
        Promise.resolve(scanKey === broader ? cachedProgress : null),
      onScanProgress: (callback: typeof push) => {
        push = callback
        return () => undefined
      }
    }
  })
  const local = renderHook(() => useAiVaultScanProgress('local', broader))
  const narrowerPanel = renderHook(() => useAiVaultScanProgress('local', narrower))
  const remote = renderHook(() => useAiVaultScanProgress('runtime:server-1', broader))
  const allHosts = renderHook(() => useAiVaultScanProgress('all', broader))
  await waitFor(() => expect(local.result.current?.progress).toBe(cachedProgress))
  act(() => push({ scanKey: broader, progress: cachedProgress }))

  expect(local.result.current?.progress).toBe(cachedProgress)
  expect(narrowerPanel.result.current).toBeNull()
  act(() =>
    push({ scanKey: broader, progress: { ...cachedProgress, scanId: 'later', stage: 'finding' } })
  )
  expect(narrowerPanel.result.current).toBeNull()
  // Without remote progress evidence, retain the existing spinner/error presentation.
  expect(remote.result.current).toBeNull()
  expect(allHosts.result.current).toBeNull()
})
