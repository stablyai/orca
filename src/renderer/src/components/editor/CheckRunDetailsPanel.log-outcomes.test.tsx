// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import { readingCheck, readingDetails } from './check-details-reading-fixture'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'
import { CheckRunDetails } from '@/components/right-sidebar/checks-panel/check-run-details'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import {
  checkDetailsReadingKey,
  checkJobIdentities,
  checkReadingIntentKey
} from './check-details-reading-cache'
import * as diagnosticPosition from '@/components/right-sidebar/check-log-initial-diagnostic-position'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => String(values?.[key] ?? ''))
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => content
}))
vi.mock('./check-run-details-fix-with-ai', () => ({
  useCheckRunDetailsFixWithAI: () => ({ canFixWithAI: false })
}))
const original = useAppStore.getState()
const id = 'wt-1::check-details::check-run:42'
const context = 'outcome-context'
const check = { ...readingCheck, url: 'https://provider.test/job/7', workflowRunId: 55 }
const retry = vi.fn()
const copy = vi.fn().mockResolvedValue(undefined)

function StoredPanel({ scope = 'outcome-pane' }: { scope?: string }) {
  const file = useAppStore((state) => state.openFiles.find((tab) => tab.id === id))
  const state = file?.checkRunDetails
  return state && file ? (
    <div data-testid={scope}>
      <CheckRunDetailsPanel
        check={state.check}
        details={state.details}
        loading={state.loading}
        error={state.error}
        openUrl={state.check.url}
        worktreeId={file.worktreeId}
        tabId={file.id}
        viewStateScopeId={scope}
        contextKey={state.contextKey}
        onRefresh={() => {
          void useAppStore.getState().reloadOpenCheckRunDetailsTab(file.id)
        }}
      />
    </div>
  ) : null
}
function payload(text: string | null = null, logState: 'error' | 'available' = 'error') {
  const value = readingDetails(text, logState)
  return {
    ...value,
    startedAt: '2026-10-10T12:00:00Z',
    completedAt: '2026-10-10T12:05:00Z',
    jobs: [
      {
        ...value.jobs[0],
        startedAt: '2026-10-10T12:00:00Z',
        completedAt: '2026-10-10T12:05:00Z',
        steps: [
          {
            name: 'setup',
            status: 'completed',
            conclusion: 'success',
            startedAt: null,
            completedAt: null
          }
        ]
      }
    ]
  }
}
function open(details: PRCheckRunDetails, requestId = 0) {
  useAppStore.getState().openCheckRunDetails('wt-1', context, check, {
    requestId,
    details,
    loading: false,
    error: null
  })
}
function gate() {
  let resolve: (details: PRCheckRunDetails | null) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<PRCheckRunDetails | null>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  const fixture = createEditorTabsStore().getState()
  useAppStore.setState({
    openFiles: [],
    repos: fixture.repos,
    worktreesByRepo: fixture.worktreesByRepo,
    fetchPRCheckDetails: vi.fn()
  })
  retry.mockReset()
  copy.mockClear()
  scrollTopCache.clear()
  Object.assign(window, { api: { ui: { writeClipboardText: copy }, shell: { openUrl: vi.fn() } } })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 400, 200)
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  scrollTopCache.clear()
  vi.restoreAllMocks()
})

describe('synthetic outcome payloads through real sidebar and header actions', () => {
  it('keeps the provider action and truthful manual output without inventing failed steps', () => {
    const manualCheck = { ...check, conclusion: 'neutral' as const }
    const details = {
      ...readingDetails(),
      conclusion: 'neutral',
      summary: 'Waiting for manual approval.',
      jobs: []
    }
    render(
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={manualCheck}
          details={details}
          loading={false}
          error={null}
          openUrl={check.url}
          worktreeId={null}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Waiting for manual approval.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open details' })).toBeTruthy()
    expect(screen.queryByText('Failed jobs')).toBeNull()
    expect(screen.queryByText('Log excerpt')).toBeNull()
    expect(document.body.textContent).not.toMatch(/expired|Couldn't load logs|steps failed/)
  })
  it.each(['available', 'empty', 'not_requested', undefined] as const)(
    'does not invent first-text navigation from null outcome %s',
    async (outcome) => {
      const first = readingDetails(null, outcome)
      const pending = gate()
      useAppStore.setState({ fetchPRCheckDetails: vi.fn(() => pending.promise) })
      open(first)
      const marker = vi.spyOn(diagnosticPosition, 'findInitialCheckLogDiagnostic')
      render(
        <TooltipProvider>
          <StoredPanel />
        </TooltipProvider>
      )
      expect(scrollTopCache.size).toBe(1)
      expect([...scrollTopCache.keys()].some((key) => key.includes('::intent:'))).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      await act(async () => pending.resolve(readingDetails(undefined, 'available')))
      expect(screen.getByTestId('outcome-pane').querySelector('pre')?.scrollTop).toBe(0)
      expect(marker).not.toHaveBeenCalled()
    }
  )

  it('ends zero-layout first-text setup and cannot revive it after close or late frames', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
      frames.delete(key)
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0)
    const first = payload()
    const pending = gate()
    useAppStore.setState({ fetchPRCheckDetails: vi.fn(() => pending.promise) })
    open(first)
    const marker = vi.spyOn(diagnosticPosition, 'findInitialCheckLogDiagnostic')
    const { unmount } = render(
      <TooltipProvider>
        <StoredPanel />
      </TooltipProvider>
    )
    expect(marker).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () =>
      pending.resolve(payload('Error: synthetic delayed first text', 'available'))
    )
    const queued = [...frames.values()]
    act(() => {
      frames.clear()
      for (const callback of queued) {
        callback(0)
      }
    })
    expect(marker).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    fireEvent.resize(window)
    expect(marker).not.toHaveBeenCalled()
    act(() => {
      useAppStore.setState({ openFiles: [] })
    })
    scrollTopCache.clear()
    act(() => {
      for (const callback of queued) {
        callback(0)
      }
    })
    unmount()
    expect(scrollTopCache.size).toBe(0)
    expect(frames.size).toBe(0)
  })

  it.each([false, true])(
    'retries one combined request with unchanged identities, already open=%s',
    async (alreadyOpen) => {
      const first = payload()
      first.jobs.push({
        ...first.jobs[0],
        id: 8,
        name: 'retained',
        logState: 'available',
        logTail: 'Error: retained synthetic excerpt'
      })
      const next = {
        ...first,
        jobs: first.jobs.map((job) => ({
          ...job,
          logState: 'available' as const,
          logTail: job.logTail ?? 'Error: recovered synthetic excerpt'
        }))
      }
      const pending = gate()
      const fetch = vi.fn(() => pending.promise)
      useAppStore.setState({ fetchPRCheckDetails: fetch })
      if (alreadyOpen) {
        open(first)
      }
      render(
        <TooltipProvider>
          <CheckRunDetails
            check={check}
            state={{ requestId: 0, details: first, loading: false, error: null }}
            checkDetailsContextKey={context}
            worktreeId="wt-1"
            onRetry={retry}
          />
          <StoredPanel />
        </TooltipProvider>
      )
      expect(
        screen.getByText("Couldn't load logs. Open View full details, then use Refresh to retry.")
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'View full details' }))
      expect(useAppStore.getState().openFiles[0].checkRunDetails?.details).toBe(first)
      expect(fetch).not.toHaveBeenCalled()
      const panel = screen.getByTestId('outcome-pane')
      const pre = panel.querySelector('pre')
      const outer = panel.querySelector('[aria-busy].overflow-y-auto')
      if (!(pre instanceof HTMLPreElement) || !(outer instanceof HTMLDivElement)) {
        throw new Error('Missing retained reading nodes')
      }
      fireEvent.wheel(pre)
      pre.scrollTop = 180
      fireEvent.scroll(pre)
      outer.scrollTop = 320
      fireEvent.scroll(outer)
      const geometry = { excerpt: pre.getBoundingClientRect().top, height: outer.clientHeight }
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Copy log excerpt' }))
      })
      expect(copy).toHaveBeenCalledExactlyOnceWith(first.jobs[1].logTail)
      expect(fetch).not.toHaveBeenCalled()
      fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }))
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(
        '/repo',
        { checkRunId: 42, workflowRunId: 55, checkName: 'verify', url: check.url, prRepo: null },
        { repoId: 'repo-1' }
      )
      const during = useAppStore.getState().openFiles[0].checkRunDetails
      const positions = [...scrollTopCache]
      fireEvent.click(screen.getByRole('button', { name: 'View full details' }))
      act(() => {
        useAppStore.getState().patchOpenCheckRunDetails('wt-1', context, check, {
          requestId: 0,
          details: first,
          loading: false,
          error: null
        })
      })
      expect(useAppStore.getState().openFiles[0].checkRunDetails).toBe(during)
      expect([...scrollTopCache]).toEqual(positions)
      expect(panel.querySelector('pre')).toBe(pre)
      expect(pre.scrollTop).toBe(180)
      expect(outer.scrollTop).toBe(320)
      expect(within(panel).getByText("Couldn't load logs. Use Refresh to retry.")).toBeTruthy()
      await act(async () => pending.resolve(next))
      expect(useAppStore.getState().openFiles[0].checkRunDetails?.details).toBe(next)
      expect(panel.querySelectorAll('pre')[1]).toBe(pre)
      expect(pre.scrollTop).toBe(180)
      expect(outer.scrollTop).toBe(320)
      expect({ excerpt: pre.getBoundingClientRect().top, height: outer.clientHeight }).toEqual(
        geometry
      )
      expect(within(panel).queryByText("Couldn't load logs. Use Refresh to retry.")).toBeNull()
      expect(within(panel).getByRole('button', { name: 'Open details' })).toBeTruthy()
      const accepted = useAppStore.getState().openFiles[0].checkRunDetails
      const saved = [...scrollTopCache]
      fireEvent.click(screen.getByRole('button', { name: 'View full details' }))
      expect(useAppStore.getState().openFiles[0].checkRunDetails).toBe(accepted)
      expect([...scrollTopCache]).toEqual(saved)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(retry).not.toHaveBeenCalled()
      expect(next.jobs.map(({ logState: _state, logTail: _tail, ...job }) => job)).toEqual(
        first.jobs.map(({ logState: _state, logTail: _tail, ...job }) => job)
      )
    }
  )

  it.each(['untouched', 'outer wheel', 'outer scroll', 'steps', 'evicted'])(
    'allows error-only first text exactly once when intent survives %s',
    async (interaction) => {
      const first = payload()
      const next = payload(
        'prefix\nError: recovered synthetic diagnostic\n at synthetic.ts:1:2',
        'available'
      )
      const pending = gate()
      const fetch = vi.fn(() => pending.promise)
      useAppStore.setState({ fetchPRCheckDetails: fetch })
      open(first)
      const marker = vi.spyOn(diagnosticPosition, 'findInitialCheckLogDiagnostic')
      const measure = vi
        .spyOn(diagnosticPosition, 'measureInitialCheckLogScrollTop')
        .mockReturnValue(600)
      const { unmount } = render(
        <TooltipProvider>
          <StrictMode>
            <StoredPanel />
          </StrictMode>
        </TooltipProvider>
      )
      const panel = screen.getByTestId('outcome-pane')
      const outer = panel.querySelector('[aria-busy].overflow-y-auto')
      if (!(outer instanceof HTMLDivElement)) {
        throw new Error('Missing outer scroller')
      }
      const identity = checkJobIdentities(first.jobs)[0].identity
      const owner = checkDetailsReadingKey(id, 'outcome-pane', context)
      expect(scrollTopCache.get(checkReadingIntentKey(owner, identity))).toBe(-1)
      expect(
        scrollTopCache.has(
          checkReadingIntentKey(checkDetailsReadingKey(id, null, context), identity)
        )
      ).toBe(false)
      if (interaction === 'outer wheel') {
        fireEvent.wheel(outer)
      }
      if (interaction === 'outer scroll') {
        outer.scrollTop = 320
        fireEvent.scroll(outer)
      }
      if (interaction === 'steps') {
        fireEvent.click(within(panel).getByRole('button', { name: '1 succeeded' }))
      }
      if (interaction === 'evicted') {
        for (let index = 0; index < 21; index++) {
          setWithLRU(scrollTopCache, `ordinary-${index}`, index)
        }
      }
      fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }))
      expect(panel.querySelector('pre')).toBeNull()
      await act(async () => pending.resolve(next))
      expect(marker).toHaveBeenCalledTimes(interaction === 'untouched' ? 1 : 0)
      expect(measure).toHaveBeenCalledTimes(interaction === 'untouched' ? 1 : 0)
      expect(panel.querySelector('pre')?.scrollTop).toBe(interaction === 'untouched' ? 600 : 0)
      expect(fetch).toHaveBeenCalledTimes(1)
      unmount()
      render(
        <TooltipProvider>
          <StoredPanel />
        </TooltipProvider>
      )
      expect(marker).toHaveBeenCalledTimes(interaction === 'untouched' ? 1 : 0)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it('claims an error-only intent in one pane and cancels only the interacted job', async () => {
    const first = payload()
    first.jobs.push({ ...first.jobs[0], id: 8, name: 'other-error' })
    const pending = gate()
    useAppStore.setState({ fetchPRCheckDetails: vi.fn(() => pending.promise) })
    open(first)
    const marker = vi.spyOn(diagnosticPosition, 'findInitialCheckLogDiagnostic')
    vi.spyOn(diagnosticPosition, 'measureInitialCheckLogScrollTop').mockReturnValue(600)
    render(
      <TooltipProvider>
        <StoredPanel scope="left" />
        <StoredPanel scope="right" />
      </TooltipProvider>
    )
    const left = screen.getByTestId('left')
    const right = screen.getByTestId('right')
    fireEvent.click(within(left).getAllByRole('button', { name: '1 succeeded' })[0])
    fireEvent.click(within(right).getByRole('button', { name: 'Refresh' }))
    const next = {
      ...first,
      jobs: first.jobs.map((job) => ({
        ...job,
        logState: 'available' as const,
        logTail: `Error: synthetic ${job.name}`
      }))
    }
    await act(async () => pending.resolve(next))
    expect(marker).toHaveBeenCalledTimes(1)
    expect([...left.querySelectorAll('pre')].map((pre) => pre.scrollTop)).toEqual([0, 600])
    expect([...right.querySelectorAll('pre')].map((pre) => pre.scrollTop)).toEqual([0, 0])
  })
})
