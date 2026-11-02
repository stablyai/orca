// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanProgress } from '../../../../shared/ai-vault-scan-progress'
import { aiVaultLocalScanKey } from '../../../../shared/ai-vault-local-scan-key'
import { AiVaultScanProgressStrip } from './AiVaultScanProgressStrip'
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

it('says the finished total in the strip and opens to one row per agent', async () => {
  render(<AiVaultScanProgressStrip progress={FINISHED} />)
  expect(screen.getByText('102,452 files').parentElement?.textContent).toBe('Scanned 102,452 files')
  expect(screen.queryByText('Codex')).toBeNull()

  await userEvent.setup().click(screen.getByRole('button'))
  expect(screen.getByText('77,483 files')).toBeTruthy()
  expect(screen.getByText('1 database')).toBeTruthy()
})

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
  const remote = renderHook(() =>
    useAiVaultScanProgress('runtime:server-1', broader)
  )
  const allHosts = renderHook(() => useAiVaultScanProgress('all', broader))
  await waitFor(() => expect(local.result.current?.progress).toBe(cachedProgress))
  act(() => push({ scanKey: broader, progress: cachedProgress }))

  expect(local.result.current?.progress).toBe(cachedProgress)
  expect(narrowerPanel.result.current).toBeNull()
  act(() =>
    push({ scanKey: broader, progress: { ...cachedProgress, scanId: 'later', stage: 'finding' } })
  )
  expect(narrowerPanel.result.current).toBeNull()
  // A remote host has no progress stream yet; its panel keeps today's spinner and error line.
  expect(remote.result.current).toBeNull()
  expect(allHosts.result.current).toBeNull()
})

it('keeps real rows through partial rescans, detached keys and failed retries', async () => {
  let push: (update: { scanKey: string; progress: AiVaultScanProgress | null }) => void = () =>
    undefined
  vi.stubGlobal('api', {
    aiVault: {
      getScanProgress: () => new Promise<null>(() => undefined),
      onScanProgress: (callback: typeof push) => {
        push = callback
        return () => undefined
      }
    }
  })
  function Panel({ scanKey }: { scanKey: string }) {
    const progress = useAiVaultScanProgress('local', scanKey)
    return progress ? <AiVaultScanProgressStrip {...progress} /> : null
  }
  const panel = render(<Panel scanKey="worktree-a" />)
  const view = within(panel.container)
  const first: AiVaultScanProgress = {
    ...FINISHED,
    stage: 'finding',
    settledAt: null,
    agents: [FINISHED.agents[0]!]
  }
  act(() => push({ scanKey: 'worktree-a', progress: first }))
  await userEvent.setup().click(view.getByRole('button'))
  act(() => push({ scanKey: 'worktree-a', progress: { ...first, agents: [], settledAt: 1_000 } }))
  expect(view.getByText('24,968 files')).toBeTruthy()
  act(() => push({ scanKey: 'worktree-a', progress: FINISHED }))
  expect(view.getByText('Scanned', { exact: false })).toBeTruthy()
  const rowCount = () => panel.container.querySelectorAll('.h-7').length
  const assertRoster = () => expect(rowCount()).toBe(3)

  const next = { ...FINISHED, scanId: 'scan-a-next' }
  const partial: AiVaultScanProgress = { ...next, stage: 'reading', settledAt: null, agents: [] }
  act(() => push({ scanKey: 'worktree-a', progress: partial }))
  assertRoster()
  for (const agents of [
    [{ ...FINISHED.agents[0]!, files: 12, walking: true }],
    [{ agent: 'cursor' as const, files: 0, databases: 0, walking: true }],
    []
  ]) {
    act(() => push({ scanKey: 'worktree-a', progress: { ...partial, agents } }))
    assertRoster()
    expect(view.getByText('77,483 files')).toBeTruthy()
    expect(panel.container.querySelector('.animate-spin')).toBeTruthy()
  }
  expect(view.getByText('12 files')).toBeTruthy()
  expect(panel.container.querySelectorAll('.animate-spin').length).toBe(1)
  expect(view.getByText('Reading', { exact: false })).toBeTruthy()
  // Finished before the list it produced is applied: still one row, now settled.
  act(() => push({ scanKey: 'worktree-a', progress: next }))
  expect(view.getByText('Scanned', { exact: false })).toBeTruthy()

  // The old key is a static snapshot: neither pushes nor eviction may change it under B.
  panel.rerender(<Panel scanKey="worktree-b" />)
  act(() => push({ scanKey: 'worktree-a', progress: partial }))
  act(() => push({ scanKey: 'worktree-a', progress: null }))
  act(() => {
    for (let i = 0; i < 9; i++) {
      push({ scanKey: `other-${i}`, progress: partial })
    }
  })
  expect(view.getByText('Scanned', { exact: false })).toBeTruthy()
  act(() =>
    push({
      scanKey: 'worktree-b',
      progress: { ...partial, scanId: 'scan-b', stage: 'finding' }
    })
  )
  expect(view.getByText('Scanning', { exact: false })).toBeTruthy()
  assertRoster()
  panel.rerender(<Panel scanKey="worktree-c" />)
  expect(view.queryByText('Scanning', { exact: false })).toBeNull()
  expect(panel.container.querySelector('.animate-spin, .lucide-check')).toBeNull()
  for (const scanId of ['failed-first', 'failed-retry']) {
    act(() => push({ scanKey: 'worktree-c', progress: { ...partial, scanId, settledAt: 95_000 } }))
    assertRoster()
    expect(view.queryByText('Scanned', { exact: false })).toBeNull()
    expect(panel.container.querySelector('.animate-spin, .lucide-check')).toBeNull()
  }
  act(() =>
    push({ scanKey: 'worktree-c', progress: { ...next, agents: [FINISHED.agents[0]!] } })
  )
  expect(rowCount()).toBe(1)
})
