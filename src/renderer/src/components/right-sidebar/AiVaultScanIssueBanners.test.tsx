// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'
import type { AiVaultListResult, AiVaultScanIssue } from '../../../../shared/ai-vault-types'

const notice: AiVaultScanIssue = {
  executionHostId: 'ssh:build',
  agent: 'codex',
  kind: 'notice',
  path: '/sessions/large.jsonl',
  message: 'Skipped 2 oversized transcript records. The rest of the session was read.'
}
function result(issues: AiVaultScanIssue[]): AiVaultListResult {
  return { sessions: [], issues, scannedAt: '2026-11-01T00:00:00Z' }
}
function view(scanResult: AiVaultListResult) {
  return (
    <TooltipProvider>
      <AiVaultScanIssueBanners scanResult={scanResult} />
    </TooltipProvider>
  )
}
afterEach(cleanup)

it('keeps partial-history diagnostics compact and reveals their host and source on demand', async () => {
  render(view(result([notice])))
  expect(screen.queryByText(notice.message)).toBeNull()
  const trigger = screen.getByRole('button', { name: 'History notices · 1' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(trigger)
  expect(screen.getByText(notice.message)).toBeTruthy()
  expect(screen.getByText('/sessions/large.jsonl')).toBeTruthy()
  expect(screen.getByText('Codex · ssh:build')).toBeTruthy()
})

it('dismisses the same notices across refreshes and reveals newly changed diagnostics', async () => {
  const { rerender } = render(view(result([notice])))
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss history notices' }))
  rerender(view({ ...result([{ ...notice }]), scannedAt: '2026-11-01T01:00:00Z' }))
  expect(screen.queryByRole('button', { name: 'History notices · 1' })).toBeNull()
  rerender(view(result([{ ...notice, message: 'Skipped 3 oversized records.' }])))
  await userEvent.click(screen.getByRole('button', { name: 'History notices · 1' }))
  expect(screen.getByText('Skipped 3 oversized records.')).toBeTruthy()
})

it('never hides host, scope or whole-transcript failures when notices are dismissed', async () => {
  render(
    view(
      result([
        notice,
        { ...notice, kind: 'host', message: 'Host unreachable' },
        { ...notice, kind: 'scope', message: 'Project history unavailable' },
        { ...notice, kind: undefined, message: 'Transcript unreadable' }
      ])
    )
  )
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss history notices' }))
  for (const message of [
    'Host unreachable',
    'Project history unavailable',
    'Transcript unreadable'
  ]) {
    expect(screen.getByText(message)).toBeTruthy()
  }
})
