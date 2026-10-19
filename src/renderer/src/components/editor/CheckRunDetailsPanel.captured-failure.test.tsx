// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { scrollTopCache } from '@/lib/scroll-cache'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'
import { readingCheck, readingDetails } from './check-details-reading-fixture'
import {
  capturedCheckLogExcerpt,
  capturedCheckLogFailure
} from '../right-sidebar/check-job-log-captured-fixture'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
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

const original = useAppStore.getState()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const fetchDetails = vi.fn()

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  fetchDetails.mockReset()
  Object.assign(window, { api: { ui: { writeClipboardText } } })
  const fixture = createEditorTabsStore().getState()
  useAppStore.setState({
    openFiles: [],
    repos: fixture.repos,
    worktreesByRepo: fixture.worktreesByRepo,
    fetchPRCheckDetails: fetchDetails
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  scrollTopCache.clear()
})

describe('captured failure output in the details panel', () => {
  it('keeps failure context first, successes collapsed, and Copy literal without another request', async () => {
    const base = readingDetails(capturedCheckLogExcerpt, 'available')
    const check = { ...readingCheck, url: 'https://github.com/acme/widgets/actions/runs/1/job/42' }
    const details = {
      ...base,
      title: 'Provider title',
      summary: 'Provider-written output',
      annotations: [
        {
          path: 'src/example.ts',
          startLine: 1,
          endLine: 1,
          annotationLevel: 'failure',
          title: null,
          message: 'Provider annotation',
          rawDetails: null
        }
      ],
      jobs: [
        {
          ...base.jobs[0],
          name: 'Failed fixture job',
          steps: [
            {
              name: 'Test shard',
              status: 'completed',
              conclusion: 'failure',
              startedAt: null,
              completedAt: null
            },
            {
              name: 'Setup',
              status: 'completed',
              conclusion: 'success',
              startedAt: null,
              completedAt: null
            }
          ]
        }
      ]
    }
    useAppStore.getState().openCheckRunDetails('wt-1', 'captured', check, {
      details,
      loading: false,
      error: null
    })
    const { container } = render(
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={check}
          details={details}
          loading={false}
          error={null}
          openUrl={check.url}
          worktreeId="wt-1"
          tabId="wt-1::check-details::check-run:42"
          viewStateScopeId="captured-pane"
          contextKey="captured"
        />
      </TooltipProvider>
    )
    const text = container.textContent ?? ''
    const parts = [
      'Failed fixture job',
      'Test shard',
      'Log excerpt',
      capturedCheckLogFailure.expectedDiagnostic,
      '1 succeeded',
      'Output',
      'Provider-written output',
      'Annotations',
      'Provider annotation'
    ]
    const positions = parts.map((part) => text.indexOf(part))
    expect(
      positions.every(
        (position, index) => position >= 0 && (index === 0 || position > positions[index - 1])
      )
    ).toBe(true)
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toBe(capturedCheckLogExcerpt)
    expect(pre?.childNodes).toHaveLength(1)
    const disclosure = screen.getByRole('button', { name: '1 succeeded' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Setup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open details' })).toBeTruthy()
    expect(fetchDetails).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Copy log excerpt' }))
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(capturedCheckLogExcerpt)
    )
    fireEvent.click(disclosure)
    expect(screen.getByText('Setup')).toBeTruthy()
    expect(container.querySelector('pre')).toBe(pre)
    expect(fetchDetails).not.toHaveBeenCalled()
  })
})
