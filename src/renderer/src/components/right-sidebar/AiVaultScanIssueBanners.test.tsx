// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'

afterEach(() => {
  cleanup()
})

it('keeps many partial-read notices in a bounded scroll area above the session list', () => {
  const notices = Array.from({ length: 40 }, (_, index) => ({
    executionHostId: 'ssh:box' as const,
    agent: 'codex' as const,
    kind: 'notice' as const,
    path: `/home/u/.codex/sessions/rollout-${index}.jsonl`,
    message: `Skipped 1 oversized transcript record over the 10.0 MiB limit (12.0 MiB at byte ${index}). The rest of the session was read.`
  }))
  const scanResult: AiVaultListResult = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: banners only read the session count.
    sessions: [{} as AiVaultSession],
    issues: [...notices, { agent: 'codex', path: '/broken.jsonl', message: 'Unreadable' }],
    scannedAt: '2026-10-15T00:00:00.000Z'
  }

  render(<AiVaultScanIssueBanners scanResult={scanResult} />)

  const region = screen.getByTestId('ai-vault-scan-notices')
  expect(region.className).toContain('max-h-24')
  expect(region.className).toContain('overflow-y-auto')
  expect(region.children).toHaveLength(42)
  expect(region.textContent).toContain('1 transcript skipped')
})

it('renders no notice area for a clean scan', () => {
  render(
    <AiVaultScanIssueBanners
      scanResult={{ sessions: [], issues: [], scannedAt: '2026-10-15T00:00:00.000Z' }}
    />
  )
  expect(screen.queryByTestId('ai-vault-scan-notices')).toBeNull()
})
