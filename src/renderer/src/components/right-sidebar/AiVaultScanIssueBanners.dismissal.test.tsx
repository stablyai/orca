// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault-types'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'

const notice: AiVaultScanIssue = {
  agent: 'codex',
  kind: 'notice',
  path: '/history/a.jsonl',
  message: 'History A was partly read.',
  messageDetail: 'Record at byte 100'
}
const otherNotice: AiVaultScanIssue = {
  ...notice,
  path: '/history/b.jsonl',
  message: 'History B was partly read.'
}

function banners(issues: AiVaultScanIssue[]) {
  return (
    <TooltipProvider>
      <AiVaultScanIssueBanners
        scanResult={{ sessions: [], issues, scannedAt: '2026-11-01T00:00:00Z' }}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('history notice dismissal across scans', () => {
  it('keeps A dismissed when a scan adds B, including after a scan with no notices', () => {
    const view = render(banners([notice]))
    fireEvent.click(view.getByRole('button', { name: 'Dismiss history notices' }))
    expect(view.queryByRole('button')).toBeNull()

    view.rerender(banners([]))
    view.rerender(banners([notice, otherNotice]))
    fireEvent.click(view.getByRole('button', { name: 'History notices · 1' }))
    expect(view.queryByText(notice.message)).toBeNull()
    expect(view.getByText(otherNotice.message)).toBeTruthy()

    view.rerender(banners([otherNotice, { ...notice }]))
    expect(view.queryByText(notice.message)).toBeNull()
    expect(view.getByText(otherNotice.message)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Dismiss history notices' }))
    view.rerender(banners([notice, otherNotice]))
    expect(view.queryByRole('button')).toBeNull()
  })

  it('shows a dismissed notice again when its detail changes', () => {
    const view = render(banners([notice]))
    fireEvent.click(view.getByRole('button', { name: 'Dismiss history notices' }))
    const changed = { ...notice, messageDetail: 'Record at byte 200' }
    view.rerender(banners([notice, changed]))
    fireEvent.click(view.getByRole('button', { name: 'History notices · 1' }))
    expect(view.queryByText(notice.messageDetail ?? '')).toBeNull()
    expect(view.getByText(changed.messageDetail)).toBeTruthy()
  })
})
