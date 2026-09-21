// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

vi.mock('@/i18n/i18n', () => ({
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

afterEach(cleanup)

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText } } })
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
