// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'
import * as normalization from '@/lib/check-run-details-log-normalization'
import * as sanitation from '../../../../shared/check-job-log-excerpt'
import {
  captured,
  checkLogDetails,
  checkLogJob
} from '@/lib/check-run-details-log-normalization-test-fixture'
import { useAppStore } from '@/store'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { readingCheck, readingDetails } from './check-details-reading-fixture'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import * as diagnosticPosition from '@/components/right-sidebar/check-log-initial-diagnostic-position'
import {
  checkDetailsReadingKey,
  checkJobIdentities,
  checkLogDigest,
  checkReadingLogKey
} from './check-details-reading-cache'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const prCheckDetails = vi.fn()
const runtimeCall = vi.fn()

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => String(values?.[key] ?? ''))
}))

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => content
}))

vi.mock('@/components/right-sidebar/source-control-fix-split-button', () => ({
  SourceControlFixSplitButton: () => null
}))

vi.mock('./check-run-details-fix-with-ai', () => ({
  useCheckRunDetailsFixWithAI: () => ({
    canFixWithAI: false,
    disabledReason: null,
    isFixing: false,
    fixPrompt: '',
    repoId: null,
    connectionId: null,
    launchPlatform: null,
    savedAgentId: null,
    savedCommandInputTemplate: null,
    savedAgentArgs: [],
    saveLaunchActionDefault: vi.fn(),
    openSourceControlAiSettings: vi.fn(),
    fixWithAI: vi.fn()
  })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  prCheckDetails.mockReset()
  runtimeCall.mockReset()
  Object.assign(window, {
    api: {
      ui: { writeClipboardText },
      gh: { prCheckDetails },
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeCall, subscribe: runtimeCall }
    }
  })
})

const check: PRCheckDetail = {
  name: 'package',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  checkRunId: 42
}

const details: PRCheckRunDetails = {
  name: 'package',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: 'Build failed',
  summary: 'One test failed.',
  text: 'Run the suite locally.',
  annotations: [
    {
      path: 'src/main.ts',
      startLine: 10,
      endLine: 10,
      annotationLevel: 'failure',
      title: 'Type error',
      message: 'Expected string',
      rawDetails: 'Actual: number'
    }
  ],
  jobs: [
    {
      id: 1,
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null,
      url: null,
      logTail: 'AssertionError: expected true',
      steps: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          startedAt: null,
          completedAt: null
        }
      ]
    }
  ]
}

describe('CheckRunDetailsPanel card copy actions', () => {
  it('displays and copies the loaded scrubbed diagnostic without sanitation or another request', async () => {
    const normalize = vi.spyOn(normalization, 'normalizeCheckRunDetailsLogTails')
    const sanitize = vi.spyOn(sanitation, 'sanitizeCheckJobLogExcerpt')
    const loaded = normalization.normalizeCheckRunDetailsLogTails(
      checkLogDetails([checkLogJob(captured.rawLog)])
    )
    if (!loaded) {
      throw new Error('Expected details')
    }
    const panel = (
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={check}
          details={loaded}
          loading={false}
          error={null}
          openUrl={null}
          worktreeId={null}
        />
      </TooltipProvider>
    )
    const view = render(panel)
    const excerpt = view.container.querySelector('pre')
    expect(excerpt?.textContent).toContain(captured.expectedDiagnostic)
    expect(excerpt?.textContent).toContain(captured.expectedStackFrame)
    expect(excerpt?.textContent).not.toContain('\x1b')
    view.rerender(panel)
    fireEvent.click(screen.getByRole('button', { name: 'Copy jobs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy log excerpt' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(2))
    expect(writeClipboardText.mock.calls[0][0]).toContain(captured.expectedDiagnostic)
    expect(writeClipboardText.mock.calls[0][0]).toContain(captured.expectedStackFrame)
    expect(writeClipboardText).toHaveBeenLastCalledWith(loaded.jobs[0].logTail)
    expect(normalize).toHaveBeenCalledOnce()
    expect(sanitize).toHaveBeenCalledOnce()
    expect(prCheckDetails).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('renders a copy action for every card and copies each card payload', async () => {
    render(
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={check}
          details={details}
          loading={false}
          error={null}
          openUrl={null}
          worktreeId={null}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy annotations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy jobs' }))

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(3))
    expect(writeClipboardText).toHaveBeenNthCalledWith(
      1,
      'Build failed\n\nOne test failed.\n\nRun the suite locally.'
    )
    expect(writeClipboardText).toHaveBeenNthCalledWith(
      2,
      'src/main.ts:10\nfailure\nType error\nExpected string\nActual: number'
    )
    expect(writeClipboardText).toHaveBeenNthCalledWith(
      3,
      'unit: failure\ntest: failure\nAssertionError: expected true'
    )
  })
})

function panel(payload = details, loading = false, error: string | null = null) {
  return (
    <TooltipProvider>
      <CheckRunDetailsPanel
        check={check}
        details={payload}
        loading={loading}
        error={error}
        openUrl="https://provider.test/job/1"
        worktreeId={null}
        onRefresh={() => {}}
      />
    </TooltipProvider>
  )
}

describe('failure presentation and combined refresh', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('puts failed jobs, actual failed steps and excerpt before other steps, Output and annotations', async () => {
    const payload = {
      ...details,
      jobs: [
        {
          ...details.jobs[0],
          steps: [
            ...details.jobs[0].steps,
            {
              name: 'setup only',
              status: 'completed',
              conclusion: 'success',
              startedAt: null,
              completedAt: null
            }
          ]
        }
      ]
    }
    const { container } = render(panel(payload))
    const text = container.textContent ?? ''
    const positions = [
      'Failed jobs',
      'unit',
      'test',
      'Log excerpt',
      '1 succeeded',
      'Output',
      'Annotations'
    ].map((part) => text.indexOf(part))
    expect(
      positions.every((position, index) => index === 0 || position > positions[index - 1])
    ).toBe(true)
    expect(screen.queryByText('setup only')).toBeNull()
    expect(screen.getByText('Build failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open details' })).toBeTruthy()
    const disclosure = screen.getByRole('button', { name: '1 succeeded' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    const user = userEvent.setup()
    disclosure.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('setup only')).toBeTruthy()
    expect(container.querySelectorAll('button button')).toHaveLength(0)
  })

  it('resets only the disclosure when a successful setup-only job becomes failed', () => {
    const setup = {
      name: 'setup only',
      status: 'completed',
      conclusion: 'success',
      startedAt: null,
      completedAt: null
    }
    const first = {
      ...details,
      conclusion: 'success',
      jobs: [{ ...details.jobs[0], conclusion: 'success', steps: [setup] }]
    }
    const { rerender, container } = render(panel(first))
    const pre = container.querySelector('pre.max-h-72')
    expect(screen.getByRole('button', { name: '1 succeeded' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    rerender(
      panel({
        ...first,
        conclusion: 'failure',
        jobs: [{ ...first.jobs[0], conclusion: 'startup_failure' }]
      })
    )
    expect(screen.getByRole('button', { name: '1 succeeded' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(container.querySelector('pre.min-h-48')).toBe(pre)
    expect(screen.queryByText('setup only')).toBeNull()
  })

  it('keeps stable job viewers when equal-named jobs reorder under new payload objects', () => {
    const one = details.jobs[0]
    const two = { ...one, id: 2, logTail: 'Error: second synthetic failure' }
    const { container, rerender } = render(panel({ ...details, jobs: [one, two] }))
    const first = container.querySelector('pre')
    if (!first) {
      throw new Error('Missing job viewer')
    }
    first.scrollTop = 180
    rerender(panel({ ...details, jobs: [{ ...two }, { ...one }] }))
    const viewers = [...container.querySelectorAll('pre')]
    expect(viewers[1]).toBe(first)
    expect(first.scrollTop).toBe(180)
  })

  it.each([null, 'No details are available for this check.', 'Failed to load check details.'])(
    'keeps the viewer and reading offsets through pending and %s completion',
    (error) => {
      vi.useFakeTimers()
      const { container, rerender } = render(panel())
      const pre = container.querySelector('pre')
      const outer = container.querySelector('[aria-busy].overflow-y-auto')
      if (!(pre instanceof HTMLPreElement) || !(outer instanceof HTMLDivElement)) {
        throw new Error('Missing reading nodes')
      }
      pre.scrollTop = 180
      outer.scrollTop = 320
      fireEvent.scroll(pre)
      fireEvent.scroll(outer)
      rerender(panel(details, true))
      expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('button', { name: 'Refresh' }).getAttribute('aria-busy')).toBe('true')
      expect(screen.queryByText('Refreshing check details…')).toBeNull()
      act(() => vi.advanceTimersByTime(201))
      expect(screen.getByText('Refreshing check details…')).toBeTruthy()
      const strip = screen.getByText('Refreshing check details…').parentElement
      expect(strip?.classList.contains('h-12')).toBe(true)
      expect(strip?.classList.contains('scrollbar-sleek')).toBe(true)
      expect(outer.contains(strip)).toBe(false)
      rerender(panel({ ...details, jobs: details.jobs.map((job) => ({ ...job })) }, false, error))
      expect(container.querySelector('pre')).toBe(pre)
      expect(pre.scrollTop).toBe(180)
      expect(outer.scrollTop).toBe(320)
      expect(screen.queryByText('Refreshing check details…')).toBeNull()
      expect(strip?.classList.contains('h-12')).toBe(true)
      expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false)
      if (error) {
        expect(screen.getByRole('alert').textContent).toBe(error)
      }
    }
  )

  it('never flashes progress on a fast request and clears presentation timers on unmount', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(panel())
    rerender(panel(details, true))
    act(() => vi.advanceTimersByTime(100))
    rerender(panel(details))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.queryByText('Refreshing check details…')).toBeNull()
    rerender(panel(details, true))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves literal GitLab flat traces and provider-only output', () => {
    const flat = {
      ...details,
      jobs: [
        {
          ...details.jobs[0],
          steps: [],
          logTail: 'ERROR: Job failed: exit code 1\n<script>literal</script>'
        }
      ]
    }
    const { container, rerender } = render(panel(flat))
    expect(container.querySelector('pre')?.textContent).toContain('<script>literal</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByRole('button', { name: /succeeded/ })).toBeNull()
    rerender(panel({ ...details, jobs: [], annotations: [] }))
    expect(screen.getByText('Build failed')).toBeTruthy()
    expect(container.textContent).toContain('One test failed.')
    expect(screen.queryByText('Failed jobs')).toBeNull()
  })

  it('has a translated copy name and does not create feedback timers after async unmount', async () => {
    let resolve: () => void = () => {}
    writeClipboardText.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const { unmount } = render(panel())
    const copy = screen.getByRole('button', { name: 'Copy log excerpt' })
    expect(copy.hasAttribute('title')).toBe(false)
    fireEvent.click(copy)
    unmount()
    const timer = vi.spyOn(window, 'setTimeout')
    await act(async () => resolve())
    expect(timer.mock.calls.some(([, timeout]) => timeout === 1500)).toBe(false)
  })
})

function StoredDetailsPanel({ scope = 'real-pane' }: { scope?: string }) {
  const file = useAppStore((state) => state.openFiles[0])
  const snapshot = file?.checkRunDetails
  if (!snapshot) {
    return null
  }
  return (
    <TooltipProvider>
      <CheckRunDetailsPanel
        check={snapshot.check}
        details={snapshot.details}
        loading={snapshot.loading}
        error={snapshot.error}
        openUrl={snapshot.check.url}
        worktreeId={file.worktreeId}
        tabId={file.id}
        viewStateScopeId={scope}
        contextKey={snapshot.contextKey}
        onRefresh={() => {
          void useAppStore.getState().reloadOpenCheckRunDetailsTab(file.id)
        }}
      />
    </TooltipProvider>
  )
}

describe('mounted store-driven details refresh', () => {
  const original = useAppStore.getState()
  afterEach(() => {
    cleanup()
    useAppStore.setState(original, true)
    scrollTopCache.clear()
    vi.restoreAllMocks()
  })

  it('passes the original fallback job identity through failed-job filtering', () => {
    const fixture = createEditorTabsStore().getState()
    const base = readingDetails()
    const failed = { ...base.jobs[0], id: null, name: 'same-name' }
    const success = { ...failed, conclusion: 'success', logTail: null }
    const payload = { ...base, jobs: [success, failed] }
    useAppStore.setState({
      openFiles: [],
      repos: fixture.repos,
      worktreesByRepo: fixture.worktreesByRepo
    })
    useAppStore.getState().openCheckRunDetails('wt-1', 'context', readingCheck, {
      details: payload,
      loading: false,
      error: null
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 400, 200)
    )
    const { container } = render(<StoredDetailsPanel />)
    const pre = container.querySelector('pre')
    if (!pre) {
      throw new Error('Missing failed viewer')
    }
    fireEvent.wheel(pre)
    pre.scrollTop = 180
    fireEvent.scroll(pre)
    const id = 'wt-1::check-details::check-run:42'
    const owner = checkDetailsReadingKey(id, 'real-pane', 'context')
    const identity = checkJobIdentities(payload.jobs)[1].identity
    expect(
      scrollTopCache.get(checkReadingLogKey(owner, identity, checkLogDigest(failed.logTail ?? '')))
    ).toBe(180)
  })

  it('bounds real two-pane five-job reading and disclosure writes in the shared 20-entry cache', () => {
    const fixture = createEditorTabsStore().getState()
    const base = readingDetails()
    const payload = {
      ...base,
      jobs: Array.from({ length: 5 }, (_, index) => ({
        ...base.jobs[0],
        id: index + 1,
        name: `job-${index}`,
        logTail: `Error: synthetic failure ${index}`,
        steps: [
          {
            name: `setup-${index}`,
            status: 'completed',
            conclusion: 'success',
            startedAt: null,
            completedAt: null
          }
        ]
      }))
    }
    useAppStore.setState({
      openFiles: [],
      repos: fixture.repos,
      worktreesByRepo: fixture.worktreesByRepo
    })
    for (let index = 0; index < 8; index++) {
      setWithLRU(scrollTopCache, `ordinary-${index}`, index)
    }
    useAppStore.getState().openCheckRunDetails('wt-1', 'context', readingCheck, {
      details: payload,
      loading: false,
      error: null
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 400, 200)
    )
    const content = (
      <>
        <StoredDetailsPanel scope="left" />
        <StoredDetailsPanel scope="right" />
      </>
    )
    const { container, unmount } = render(content)
    const viewers = [...container.querySelectorAll('pre')]
    expect(viewers).toHaveLength(10)
    viewers.forEach((pre, index) => {
      fireEvent.wheel(pre)
      pre.scrollTop = 180 + index
      fireEvent.scroll(pre)
    })
    for (const disclosure of screen.getAllByRole('button', { name: '1 succeeded' })) {
      fireEvent.click(disclosure)
    }
    const outers = [...container.querySelectorAll('[aria-busy].overflow-y-auto')]
    outers.forEach((outer, index) => {
      outer.scrollTop = 320 + index
      fireEvent.scroll(outer)
    })
    expect(scrollTopCache.size).toBe(20)
    expect(
      [...scrollTopCache.values()].every((value) => Number.isFinite(value) && value >= 0)
    ).toBe(true)
    expect([...scrollTopCache.keys()].some((key) => key.includes('synthetic failure'))).toBe(false)
    unmount()
    for (let index = 0; index < 8; index++) {
      setWithLRU(scrollTopCache, `ordinary-${index}`, index)
    }
    const marker = vi.spyOn(diagnosticPosition, 'findInitialCheckLogDiagnostic')
    const remount = render(content)
    expect(marker).not.toHaveBeenCalled()
    expect(scrollTopCache.size).toBe(20)
    expect(
      [...remount.container.querySelectorAll('[data-slot=collapsible-trigger]')].some(
        (button) => button.getAttribute('aria-expanded') === 'false'
      )
    ).toBe(true)
  })
  it.each(['equal', 'null', 'throw'])(
    'preserves the actual viewer and both offsets through deferred %s requests and Strict Mode',
    async (result) => {
      const fixture = createEditorTabsStore().getState()
      const payload = readingDetails(undefined, 'available')
      let resolve: (details: PRCheckRunDetails | null) => void = () => {}
      let reject: (reason: Error) => void = () => {}
      const fetch = vi.fn(
        () =>
          new Promise<PRCheckRunDetails | null>((done, fail) => {
            resolve = done
            reject = fail
          })
      )
      useAppStore.setState({
        openFiles: [],
        repos: fixture.repos,
        worktreesByRepo: fixture.worktreesByRepo,
        fetchPRCheckDetails: fetch
      })
      useAppStore.getState().openCheckRunDetails('wt-1', 'context', readingCheck, {
        details: payload,
        loading: false,
        error: null
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 400, 200)
      )
      const { container, unmount } = render(
        <StrictMode>
          <StoredDetailsPanel />
        </StrictMode>
      )
      const pre = container.querySelector('pre')
      const outer = container.querySelector('[aria-busy].overflow-y-auto')
      if (!(pre instanceof HTMLPreElement) || !(outer instanceof HTMLDivElement)) {
        throw new Error('Missing reading nodes')
      }
      fireEvent.wheel(pre)
      pre.scrollTop = 180
      fireEvent.scroll(pre)
      outer.scrollTop = 320
      fireEvent.scroll(outer)
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(container.querySelector('pre')).toBe(pre)
      expect(pre.scrollTop).toBe(180)
      expect(outer.scrollTop).toBe(320)
      await act(async () => {
        if (result === 'throw') {
          reject(new Error('SECRET'))
        } else {
          resolve(
            result === 'null' ? null : { ...payload, jobs: payload.jobs.map((job) => ({ ...job })) }
          )
        }
      })
      expect(container.querySelector('pre')).toBe(pre)
      expect(pre.scrollTop).toBe(180)
      expect(outer.scrollTop).toBe(320)
      if (result !== 'equal') {
        expect(screen.getByRole('alert').textContent).not.toContain('SECRET')
      }
      unmount()
      const remount = render(
        <StrictMode>
          <StoredDetailsPanel />
        </StrictMode>
      )
      expect(remount.container.querySelector('pre')?.scrollTop).toBe(180)
      const remountedOuter = remount.container.querySelector('[aria-busy].overflow-y-auto')
      expect(remountedOuter?.scrollTop).toBe(320)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )
})
