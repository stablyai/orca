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
