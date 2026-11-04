// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../../shared/github/check-types'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'

import { useAppStore } from '@/store/index'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { scrollTopCache } from '@/lib/scroll-cache'
import { readingCheck, readingDetails } from '../reading/check-details-reading-fixture'
import { StrictMode } from 'react'

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

vi.mock('@/components/right-sidebar/source-control/panel/source-control-fix-split-button', () => ({
  SourceControlFixSplitButton: () => null
}))

vi.mock('../actions/check-run-details-fix-with-ai', () => ({
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
