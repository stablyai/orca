import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { aiVaultScanIssueText } from '../../../../shared/ai-vault-scan-issue-copy'
import { aiVaultScanErrorText, aiVaultScanIssueDisplayText } from './ai-vault-scan-issue-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

async function useSpanish(): Promise<void> {
  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
}

describe('aiVaultScanIssueDisplayText', () => {
  it('localizes coded issues and keeps host values and detail verbatim', async () => {
    await useSpanish()
    const stopped = aiVaultScanIssueText('wslDistroNotRunning', {
      params: { distro: 'Ubuntu' }
    })
    expect(stopped.message).toBe(
      "WSL transcript files are unavailable because WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
    )
    expect(aiVaultScanIssueDisplayText(stopped)).toBe(
      es.aiVault.scanIssues.wslDistroNotRunning.replace('{{distro}}', 'Ubuntu')
    )
    const detail = 'SQLITE_BUSY {{detail}}'
    const incomplete = aiVaultScanIssueText('openCodeScanIncomplete', {
      detail
    })
    expect(incomplete.message).toBe(`OpenCode history scan did not complete: ${detail}`)
    expect(aiVaultScanIssueDisplayText(incomplete)).toBe(
      es.aiVault.scanIssues.openCodeScanIncomplete.replace('{{detail}}', () => detail)
    )
  })

  it('localizes the notice for WSL rows carried over from the last confirmed scan', async () => {
    await useSpanish()
    const carried = aiVaultScanIssueText('wslSessionsFromLastScan')
    expect(carried.message).toBe('WSL could not be checked; its sessions are from the last scan.')
    expect(aiVaultScanIssueDisplayText(carried)).toBe(es.aiVault.scanIssues.wslSessionsFromLastScan)
  })

  it('shows the English message for uncoded, unknown, or incomplete issues', async () => {
    await useSpanish()
    expect(aiVaultScanIssueDisplayText({ message: 'Old host text' })).toBe('Old host text')
    expect(
      aiVaultScanIssueDisplayText({
        message: 'Newer',
        messageCode: 'futureCode'
      })
    ).toBe('Newer')
    expect(
      aiVaultScanIssueDisplayText({
        message: 'English',
        messageCode: 'toString'
      })
    ).toBe('English')
    expect(
      aiVaultScanIssueDisplayText({
        message: 'English',
        messageCode: 'wslDistroNotRunning'
      })
    ).toBe('English')
  })

  it('localizes classified scanner faults and passes other errors through', async () => {
    await useSpanish()
    expect(aiVaultScanErrorText('AI Vault service timed out after 130000ms.')).toBe(
      es.aiVault.scanIssues.scanTimedOut.replace('{{seconds}}', '130')
    )
    expect(aiVaultScanErrorText('Permission denied: /home/ada/.codex')).toBe(
      'Permission denied: /home/ada/.codex'
    )
  })
})
