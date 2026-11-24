// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkerDockResultDialog, workerDockReasonLine } from './WorkerDockResultDialog'
import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './WorkerDockRow'

afterEach(cleanup)

const PROMPT = 'Audit the release checklist for the billing service and list gaps, changing no...'
const ERROR =
  'Creating the worktree took longer than 180 seconds, so Orca stopped Git. Set `SOME_TIMEOUT_MS` and restart. Abandoned by orca_session_id:00000000-0000-4000-8000-000000000000.'
const result: WorkerDockResult = {
  id: 'result-1',
  dispatchId: 'ctx-1',
  name: PROMPT,
  title: PROMPT,
  outcome: 'unexpected',
  body: ERROR,
  at: 1,
  settlement: 'settled-1',
  acknowledged: false,
  ownerActionsAvailable: true
}

function card(value: WorkerDockResult, error: string | null = null) {
  return render(
    <TooltipProvider>
      <WorkerDockResultDialog
        result={value}
        error={error}
        onClose={() => {}}
        onOpen={() => {}}
        onRestore={() => {}}
        onReturnFocus={() => {}}
        ownerActionsAvailable
      />
    </TooltipProvider>
  )
}

it('takes the first sentence of an error as plain text', () => {
  expect(workerDockReasonLine(ERROR)).toBe(
    'Creating the worktree took longer than 180 seconds, so Orca stopped Git.'
  )
  expect(workerDockReasonLine('no stop at the end')).toBe('no stop at the end')
})

it('shows the prompt once, the state on its own line, one reason and the raw error on request', () => {
  card(result)
  const title = screen.getByRole('heading')
  expect(title).toHaveTextContent(PROMPT)
  expect(title).toHaveAttribute('title', PROMPT)
  expect(title).not.toHaveTextContent('Stopped unexpectedly')
  expect(screen.getAllByText(PROMPT)).toHaveLength(1)
  expect(document.querySelector('[data-worker-dock-card-state]')).toHaveTextContent(
    'Stopped unexpectedly'
  )
  expect(document.querySelector('[data-worker-dock-card-reason]')).toHaveTextContent(
    'Creating the worktree took longer than 180 seconds, so Orca stopped Git.'
  )
  expect(screen.queryByText(/orca_session_id/)).toBeNull()
  const details = screen.getByRole('button', { name: 'Show details' })
  expect(details).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(details)
  expect(screen.getByText(/orca_session_id/).tagName).toBe('PRE')
  expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
})

it('reads a finished report in full with no details fold', () => {
  card({ ...result, outcome: 'succeeded', name: 'Notes', title: 'Draft notes', body: 'All done.' })
  expect(screen.getByRole('heading')).toHaveTextContent('Notes')
  expect(screen.getByText('Draft notes')).toBeInTheDocument()
  expect(screen.getByText('All done.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Open worker' })).toBeInTheDocument()
})

it('keeps one long error sentence reachable behind Show details', () => {
  const long = `Git could not create the worktree because ${'the path is locked by another process and '.repeat(4)}gave up.`
  card({ ...result, body: long })
  expect(document.querySelector('[data-worker-dock-card-reason]')).toHaveTextContent(long)
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(document.querySelector('pre')).toHaveTextContent(long)
})

it('keeps a short error of wide glyphs reachable behind Show details', () => {
  // One sentence well under 120 characters that still overflows two lines in a narrow card.
  const wide =
    'ワークツリーの作成が三分を超えたため、Gitを停止しました。環境変数を設定してからOrcaを再起動し、もう一度このワーカーを実行してください。'
  card({ ...result, body: wide })
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(document.querySelector('pre')).toHaveTextContent(wide)
})

it('keeps the report readable when Show in dock again fails', () => {
  card(
    {
      ...result,
      outcome: 'succeeded',
      name: 'Notes',
      title: 'Notes',
      body: 'All done.',
      acknowledged: true
    },
    'Could not update the dock.'
  )
  expect(screen.getByText('All done.')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Could not update the dock.')
})

it('names the shown headline in its tooltip when the name is a cut prompt', () => {
  card({
    ...result,
    name: 'Investigate failure…',
    title: 'Investigate failure in the nightly upload job'
  })
  const title = screen.getByRole('heading')
  expect(title).toHaveTextContent('Investigate failure in the nightly upload job')
  expect(title).toHaveAttribute('title', 'Investigate failure in the nightly upload job')
})

it('opens from a pointer press with focus on the card itself, so no button shows a ring', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  // A pointer press leaves its target without a keyboard focus ring.
  Object.defineProperty(opener, 'matches', {
    value: (selector: string) =>
      selector !== ':focus-visible' && Element.prototype.matches.call(opener, selector)
  })
  card(result)
  expect(document.activeElement).toBe(document.querySelector('[data-worker-dock-result-card]'))
  opener.remove()
})

it('opens from the keyboard with focus on Open worker, where its ring shows', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  // Enter or Space on a row leaves it holding a keyboard focus ring.
  Object.defineProperty(opener, 'matches', {
    value: (selector: string) =>
      selector === ':focus-visible' || Element.prototype.matches.call(opener, selector)
  })
  card(result)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open worker' }))
  opener.remove()
})

const failedRow: WorkerDockRowView = {
  id: 'home/source/worker/attempt-1',
  dispatchId: 'attempt-1',
  source: 'source',
  kind: 'worker',
  name: 'Audit the billing checklist',
  title: 'Audit the billing checklist',
  model: null,
  state: 'failed',
  changedAt: null,
  startedAt: null,
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: false,
  ownerActionsAvailable: true
}

it('names the worker and its state from the row when the saved result is unreadable', () => {
  render(
    <TooltipProvider>
      <WorkerDockResultDialog
        result={null}
        row={failedRow}
        error="The saved result could not be read."
        onClose={() => {}}
        onOpen={() => {}}
        onRestore={() => {}}
        onReturnFocus={() => {}}
        ownerActionsAvailable
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('heading')).toHaveTextContent('Audit the billing checklist')
  expect(document.querySelector('[data-worker-dock-card-state]')).toHaveTextContent('Failed')
  expect(screen.getByRole('alert')).toHaveTextContent('The saved result could not be read.')
})

it("reads a failed worker's own report in full as Markdown, with no details fold", () => {
  card({
    ...result,
    outcome: 'failed',
    report: true,
    body: 'Could not finish. See [the release log](https://example.com/log) for **two** gaps.'
  })
  expect(screen.getByRole('link', { name: 'the release log' })).toBeInTheDocument()
  expect(screen.getByText('two').tagName).toBe('STRONG')
  expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull()
  expect(document.querySelector('[data-worker-dock-card-reason]')).toBeNull()
  expect(document.querySelector('[data-worker-dock-card-state]')).toHaveTextContent('Failed')
})
