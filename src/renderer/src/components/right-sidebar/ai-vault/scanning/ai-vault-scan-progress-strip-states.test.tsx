// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
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

it('does not turn an earlier finished scan back into loading', () => {
  render(<AiVaultScanProgressStrip progress={finished('earlier')} listPending />)
  expect(screen.getByText('History refreshed')).toBeTruthy()
})
