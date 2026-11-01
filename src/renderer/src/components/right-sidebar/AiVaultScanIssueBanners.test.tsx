// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { aiVaultScanIssueText } from '../../../../shared/ai-vault-scan-issue-copy'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'

const originalLanguage = i18n.language

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage(originalLanguage)
})

function result(
  sessions: { id: string }[],
  issues: AiVaultListResult['issues']
): AiVaultListResult {
  return {
    sessions: sessions as AiVaultListResult['sessions'],
    issues,
    scannedAt: '2026-11-01T00:00:00.000Z'
  }
}

const tooLarge = {
  executionHostId: 'local' as const,
  agent: 'codex' as const,
  path: '/sessions/rollout.jsonl',
  ...aiVaultScanIssueText('transcriptTooLarge', { params: { label: 'Codex' } })
}

it('shows no notice rows for a recovered conversation', () => {
  render(<AiVaultScanIssueBanners scanResult={result([{ id: 'recovered' }], [])} />)

  expect(screen.queryByTestId('ai-vault-scan-notices')).toBeNull()
})

it('names the agent of a conversation too large to load, in English and translated', async () => {
  const { rerender } = render(
    <AiVaultScanIssueBanners scanResult={result([{ id: 'empty-row' }], [tooLarge])} />
  )

  const notices = screen.getByTestId('ai-vault-scan-notices')
  expect(notices.textContent).toBe(`1 transcript skipped${tooLarge.message}`)
  expect(tooLarge.message).toBe(
    'A Codex conversation is too large to load in Session History. Try resuming it in Codex directly.'
  )

  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
  rerender(<AiVaultScanIssueBanners scanResult={result([{ id: 'empty-row' }], [tooLarge])} />)

  expect(screen.getByTestId('ai-vault-scan-notices').textContent).toBe(
    `1 transcripción omitida${es.aiVault.scanIssues.transcriptTooLarge.replaceAll('{{label}}', 'Codex')}`
  )
})
