// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AiVaultScanProgress } from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { AiVaultScanProgressStrip } from './AiVaultScanProgressStrip'

afterEach(cleanup)

function scan(stage: AiVaultScanProgress['stage'], files: number): AiVaultScanProgress {
  return {
    scanId: 'scan-1',
    stage,
    startedAt: 1_700_000_000_000,
    settledAt: null,
    agents: [{ agent: 'codex', files, databases: 0, walking: stage === 'finding' }],
    read: { done: 3, total: 10 }
  }
}

it('shows the label without a count until a file is found', () => {
  render(<AiVaultScanProgressStrip progress={scan('finding', 0)} />)
  expect(screen.getByTitle('Loading sessions…')).toBeTruthy()
  expect(screen.queryByText(/0 files/)).toBeNull()
})

it('shows the found count once files are found, then the reading count', () => {
  const { rerender } = render(<AiVaultScanProgressStrip progress={scan('finding', 12)} />)
  expect(screen.getByTitle('Loading sessions: 12 files')).toBeTruthy()

  rerender(<AiVaultScanProgressStrip progress={scan('reading', 12)} />)
  expect(screen.getByTitle('Loading sessions: 3 / 10')).toBeTruthy()
})

function finished(scanId = 'scan-1'): AiVaultScanProgress {
  return { ...scan('reading', 12), scanId, stage: 'finished', settledAt: 1_700_000_005_000 }
}

it('keeps a watched scan loading until its list is shown, then says it refreshed', () => {
  const { rerender } = render(
    <AiVaultScanProgressStrip progress={scan('reading', 12)} listPending />
  )
  rerender(<AiVaultScanProgressStrip progress={finished()} listPending />)
  expect(screen.getByTitle('Loading sessions: 12 files')).toBeTruthy()
  expect(screen.queryByText('History refreshed')).toBeNull()

  rerender(<AiVaultScanProgressStrip progress={finished()} listPending={false} />)
  expect(screen.getByText('History refreshed')).toBeTruthy()
})

// A wait with no scan of its own: spinner and label only, nothing carried over from an earlier scan.
function expectPlainLoading(): void {
  expect(screen.getByTitle('Loading sessions…')).toBeTruthy()
  expect(screen.queryByText('History refreshed')).toBeNull()
  expect(screen.queryByText(/\d[\d,]* files?|\d+ \/ \d+/)).toBeNull()
  expect(screen.queryByText(/\d+:\d\d|ago|Just now/)).toBeNull()
}

it('shows plain loading, not an earlier finished scan, while a list is awaited', () => {
  render(<AiVaultScanProgressStrip progress={finished('earlier')} listPending />)
  expectPlainLoading()
  // Opening the strip shows no per-agent counts from that earlier scan either.
  fireEvent.click(screen.getByRole('button'))
  expect(screen.queryByText('Codex')).toBeNull()
})

function Strip(props: { progress: AiVaultScanProgress; pending: boolean; generation: string }) {
  return (
    <AiVaultScanProgressStrip
      progress={props.progress}
      listPending={props.pending}
      listGeneration={props.generation}
    />
  )
}

it('does not revive a published scan when a later wait for the same list starts', () => {
  const { rerender } = render(<Strip progress={scan('reading', 12)} pending generation="0:a" />)
  rerender(<Strip progress={finished()} pending generation="0:a" />)
  expect(screen.getByTitle('Loading sessions: 12 files')).toBeTruthy()
  // Its list is shown, then a later refresh waits on a cached answer with no new scan.
  rerender(<Strip progress={finished()} pending={false} generation="1:a" />)
  expect(screen.getByText('History refreshed')).toBeTruthy()
  rerender(<Strip progress={finished()} pending generation="1:a" />)
  expectPlainLoading()
  // The later list lands: the strip says refreshed in that same update.
  rerender(<Strip progress={finished()} pending={false} generation="2:a" />)
  expect(screen.getByText('History refreshed')).toBeTruthy()
})

it('does not attribute a retained scan to a different list', () => {
  const { rerender } = render(<Strip progress={scan('reading', 12)} pending generation="0:a" />)
  rerender(<Strip progress={finished()} pending generation="0:a" />)
  // The wait moves to another list before the first one is shown.
  rerender(<Strip progress={finished()} pending generation="0:b" />)
  expectPlainLoading()
})

it('does not hold a scan that ran while no list was awaited', () => {
  const { rerender } = render(
    <Strip progress={scan('reading', 12)} pending={false} generation="0:a" />
  )
  rerender(<Strip progress={finished()} pending generation="0:a" />)
  expectPlainLoading()
})
