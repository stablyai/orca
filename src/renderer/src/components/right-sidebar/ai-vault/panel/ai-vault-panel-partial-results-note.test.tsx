// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  AiVaultScanProgress,
  AiVaultScanProgressUpdate
} from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { useAppStore } from '@/store/index'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { resetAiVaultForcedRescanThrottleForTest } from '../scanning/ai-vault-session-refresh'
import AiVaultPanel from './AiVaultPanel'

const confirm = async (): Promise<boolean> => true
function renderPanel(): void {
  render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <AiVaultPanel initialQuery="demo" />
    </ConfirmationDialogContext.Provider>
  )
}

const NOTE = 'Session list loading; results may be incomplete.'
const initialAppState = useAppStore.getInitialState()

function demoSession(): AiVaultSession {
  const at = '2026-07-01T00:00:00.000Z'
  return {
    id: 'demo-1',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'demo-1',
    title: 'Plan a demo garden',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/sessions/demo-1.jsonl',
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'demo-1',
    subagent: null
  }
}

const listed: AiVaultListResult = {
  sessions: [demoSession()],
  issues: [],
  scannedAt: '2026-07-01T00:00:00.000Z'
}

function deferred(): { promise: Promise<AiVaultListResult>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<AiVaultListResult>((done) => (resolve = () => done(listed)))
  return { promise, resolve }
}

const listSessions = vi.fn<() => Promise<AiVaultListResult>>()
let pushProgress: (update: AiVaultScanProgressUpdate) => void = () => {}
// The progress store requests each scan key once per module, so keep the last one across tests.
let lastScanKey = ''

beforeEach(() => {
  listSessions.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: {
      listSessions,
      cancelListSessions: async () => {},
      onWindowFocused: () => () => {},
      onScanProgress: (listener: (update: AiVaultScanProgressUpdate) => void) => {
        pushProgress = listener
        return () => {}
      },
      getScanProgress: async (scanKey: string) => {
        lastScanKey = scanKey
        return null
      }
    }
  }
  resetAiVaultForcedRescanThrottleForTest()
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState, true)
  vi.unstubAllGlobals()
})

function activeScan(): AiVaultScanProgress {
  return {
    scanId: 'scan-1',
    stage: 'reading',
    startedAt: 1_700_000_000_000,
    settledAt: null,
    agents: [{ agent: 'codex', files: 10, databases: 0, walking: false }],
    read: { done: 3, total: 10 }
  }
}

it('shows the partial-results note while the panel’s own refresh loads the list', async () => {
  const scan = deferred()
  listSessions.mockReturnValueOnce(scan.promise)
  renderPanel()
  await screen.findByText(NOTE)

  await act(async () => scan.resolve())
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
})

it('keeps the note hidden during a background scan, while the strip still shows it', async () => {
  listSessions.mockResolvedValueOnce(listed)
  renderPanel()
  await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())

  const background = deferred()
  listSessions.mockReturnValueOnce(background.promise)
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    pushProgress({ scanKey: lastScanKey, progress: activeScan() })
  })
  expect(await screen.findByText(/Loading sessions/)).not.toBeNull()
  expect(listSessions).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(NOTE)).toBeNull()

  await act(async () => background.resolve())
})

it('says the history refreshed only when the list shows and the note clears', async () => {
  const scan = deferred()
  listSessions.mockReturnValueOnce(scan.promise)
  renderPanel()
  await screen.findByText(NOTE)
  await act(async () => pushProgress({ scanKey: lastScanKey, progress: activeScan() }))
  expect(await screen.findByText(/Loading sessions/)).not.toBeNull()

  // The scan reports done while its list is still on the way.
  await act(async () =>
    pushProgress({
      scanKey: lastScanKey,
      progress: { ...activeScan(), stage: 'finished', settledAt: 1_700_000_005_000 }
    })
  )
  expect(screen.getByText(NOTE)).not.toBeNull()
  expect(screen.queryByText('History refreshed')).toBeNull()
  expect(screen.getByText(/Loading sessions/)).not.toBeNull()

  await act(async () => scan.resolve())
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
  expect(screen.getByText('History refreshed')).not.toBeNull()
})

// Records each distinct DOM state of the note, the strip and the list header while a refresh runs.
function recordStates(): {
  states: { note: boolean; plain: boolean; refreshed: boolean; stale: boolean; list: string }[]
  stop: () => void
} {
  const states: {
    note: boolean
    plain: boolean
    refreshed: boolean
    stale: boolean
    list: string
  }[] = []
  const sample = (): void => {
    const text = document.body.textContent ?? ''
    const state = {
      note: text.includes(NOTE),
      plain: document.querySelector('[title="Loading sessions…"]') !== null,
      refreshed: text.includes('History refreshed'),
      stale: /10 files|3 \/ 10|\d+:\d\d/.test(text),
      list: text.match(/\d+ sessions?(?=Last updated)/)?.[0] ?? ''
    }
    const last = states.at(-1)
    if (!last || JSON.stringify(last) !== JSON.stringify(state)) {
      states.push(state)
    }
  }
  const observer = new MutationObserver(sample)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  sample()
  return { states, stop: () => observer.disconnect() }
}

it('shows plain loading during a later refresh with no scan, and says refreshed with its list', async () => {
  const first = deferred()
  listSessions.mockReturnValueOnce(first.promise)
  renderPanel()
  await screen.findByText(NOTE)
  await act(async () => pushProgress({ scanKey: lastScanKey, progress: activeScan() }))
  await act(async () =>
    pushProgress({
      scanKey: lastScanKey,
      progress: { ...activeScan(), stage: 'finished', settledAt: 1_700_000_005_000 }
    })
  )
  await act(async () => first.resolve())
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
  expect(screen.getByText('History refreshed')).not.toBeNull()

  // A later refresh answers from cache: no new scan reports progress.
  let resolveLater = (): void => {}
  listSessions.mockReturnValueOnce(
    new Promise((done) => {
      resolveLater = () =>
        done({
          ...listed,
          sessions: [demoSession(), { ...demoSession(), id: 'demo-2', sessionId: 'demo-2' }]
        })
    })
  )
  const recorder = recordStates()
  await act(async () => screen.getByRole('button', { name: 'Refresh Session History' }).click())
  expect(await screen.findByText(NOTE)).not.toBeNull()
  expect(screen.getByTitle('Loading sessions…')).not.toBeNull()
  expect(screen.queryByText('History refreshed')).toBeNull()

  await act(async () => resolveLater())
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
  recorder.stop()
  const { states } = recorder
  expect(states.filter((state) => state.note && state.refreshed)).toEqual([])
  expect(states.filter((state) => state.note && state.stale)).toEqual([])
  // The strip says refreshed only together with the new list, in the state the note clears.
  const firstRefreshed = states.findIndex((state, i) => i > 0 && state.refreshed)
  expect(states[firstRefreshed]).toMatchObject({ note: false, list: '2 sessions' })
  expect(states.slice(1, firstRefreshed).every((state) => state.list === '1 session')).toBe(true)
})

it('shows plain loading over shown rows when no scan has reported, and clears it with the list', async () => {
  // No scan progress at all for this list.
  await act(async () => pushProgress({ scanKey: lastScanKey, progress: null }))
  listSessions.mockResolvedValueOnce(listed)
  renderPanel()
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
  expect(screen.queryByTitle(/Loading sessions/)).toBeNull()
  expect(screen.queryByText('History refreshed')).toBeNull()

  let resolveLater = (): void => {}
  listSessions.mockReturnValueOnce(
    new Promise((done) => {
      resolveLater = () =>
        done({
          ...listed,
          sessions: [demoSession(), { ...demoSession(), id: 'demo-2', sessionId: 'demo-2' }]
        })
    })
  )
  const recorder = recordStates()
  await act(async () => screen.getByRole('button', { name: 'Refresh Session History' }).click())
  expect(await screen.findByText(NOTE)).not.toBeNull()
  expect(screen.getByTitle('Loading sessions…')).not.toBeNull()

  await act(async () => resolveLater())
  await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull())
  recorder.stop()
  expect(screen.queryByTitle(/Loading sessions/)).toBeNull()
  // In every sampled state the note and the plain loading strip appear and clear together, with no count or time.
  const pendingStates = recorder.states.filter((state) => state.note)
  expect(pendingStates.length).toBeGreaterThan(0)
  expect(pendingStates.every((state) => state.plain && !state.refreshed && !state.stale)).toBe(true)
  expect(recorder.states.at(-1)).toMatchObject({ note: false, list: '2 sessions' })
})
