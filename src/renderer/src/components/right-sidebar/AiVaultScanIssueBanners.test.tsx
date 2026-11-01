// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault-types'
import { aiVaultScanIssueText } from '../../../../shared/ai-vault-scan-issue-copy'
import { makeTabSessionHistoryRow } from '../tab-bar/tab-session-history-test-fixture'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'

const originalLanguage = i18n.language

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage(originalLanguage)
})

function result(sessions: AiVaultSession[], issues: AiVaultScanIssue[]): AiVaultListResult {
  return {
    sessions,
    issues,
    scannedAt: '2026-11-01T00:00:00.000Z'
  }
}

const recovered = makeTabSessionHistoryRow()
const emptyRow = makeTabSessionHistoryRow({ messageCount: 0, previewMessages: [] })

const tooLarge: AiVaultScanIssue = {
  executionHostId: 'local',
  agent: 'codex',
  path: '/sessions/rollout.jsonl',
  ...aiVaultScanIssueText('transcriptTooLarge', { params: { label: 'Codex' } })
}

it('shows no notice rows for a recovered conversation', () => {
  render(<AiVaultScanIssueBanners scanResult={result([recovered], [])} />)

  expect(screen.queryByTestId('ai-vault-scan-notices')).toBeNull()
})

it('names the agent of a conversation too large to load, in English and translated', async () => {
  const { rerender } = render(
    <AiVaultScanIssueBanners scanResult={result([emptyRow], [tooLarge])} />
  )

  const notices = screen.getByTestId('ai-vault-scan-notices')
  expect(notices.textContent).toBe(`1 transcript skipped${tooLarge.message}`)
  expect(tooLarge.message).toBe(
    'A Codex conversation is too large to load in Session History. Try resuming it in Codex directly.'
  )

  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
  rerender(<AiVaultScanIssueBanners scanResult={result([emptyRow], [tooLarge])} />)

  expect(screen.getByTestId('ai-vault-scan-notices').textContent).toBe(
    `1 transcripción omitida${es.aiVault.scanIssues.transcriptTooLarge.replaceAll('{{label}}', 'Codex')}`
  )
})
