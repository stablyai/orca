import type React from 'react'
import type {
  AiVaultListResult,
  AiVaultScanIssue
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultScanIssueKey,
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptIssues
} from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-issue-state'
import { translate } from '@/i18n/i18n'
import { aiVaultScanIssueDisplayText } from './ai-vault-scan-issue-copy'

const SKIPPED_TRANSCRIPT_REASON_LIMIT = 3

// Expose distinct scanner reasons, capped so large issue sets cannot overwhelm the panel.
function skippedTranscriptReasons(skipped: readonly AiVaultScanIssue[]): string[] {
  const reasons = new Set<string>()
  for (const issue of skipped) {
    const message = aiVaultScanIssueDisplayText(issue).trim()
    if (message) {
      reasons.add(message)
    }
    if (reasons.size === SKIPPED_TRANSCRIPT_REASON_LIMIT) {
      break
    }
  }
  return [...reasons]
}

// Coded scanner copy is translated; other scanner-authored messages carry host/path details verbatim.
export function AiVaultScanIssueBanners({
  scanResult
}: {
  scanResult: AiVaultListResult | null
}): React.JSX.Element {
  const blocking = blockingAiVaultScanIssue(scanResult)
  const skipped = skippedAiVaultTranscriptIssues(scanResult)

  const notices = aiVaultScanNoticeIssues(scanResult)
  const reasons = skippedTranscriptReasons(skipped)
  const hasNoticeRows = notices.length > 0 || skipped.length > 0

  return (
    <>
      {blocking ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {aiVaultScanIssueDisplayText(blocking)}
        </div>
      ) : null}
      {hasNoticeRows ? (
        // Why bounded: host and scope notices can outgrow the panel and hide the list.
        <div
          data-testid="ai-vault-scan-notices"
          className="scrollbar-sleek max-h-24 shrink-0 overflow-y-auto"
        >
          {notices.map((issue) => (
            <div
              key={aiVaultScanIssueKey(issue)}
              className={`border-b border-sidebar-border px-3 py-1.5 text-[11px] ${
                issue.kind === 'host' ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {aiVaultScanIssueDisplayText(issue)}
            </div>
          ))}
          {skipped.length > 0 ? (
            <div className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.AiVaultPanel.transcriptsSkippedCount',
                '{{count}} transcripts skipped',
                { count: skipped.length, defaultValue_one: '{{count}} transcript skipped' }
              )}
            </div>
          ) : null}
          {reasons.map((reason) => (
            <div
              key={reason}
              className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground"
            >
              {reason}
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
