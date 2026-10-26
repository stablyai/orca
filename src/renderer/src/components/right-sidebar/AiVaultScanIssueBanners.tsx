import type React from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptCount,
  skippedAiVaultTranscriptReasons
} from './ai-vault-scan-issue-state'
import { translate } from '@/i18n/i18n'

// Scanner-authored messages contain host/path/cap details and have no catalog key.
export function AiVaultScanIssueBanners({
  scanResult
}: {
  scanResult: AiVaultListResult | null
}): React.JSX.Element {
  const blocking = blockingAiVaultScanIssue(scanResult)
  const skippedTranscriptCount = skippedAiVaultTranscriptCount(scanResult)

  const notices = aiVaultScanNoticeIssues(scanResult)
  const reasons = skippedAiVaultTranscriptReasons(scanResult)
  const hasNoticeRows = notices.length > 0 || skippedTranscriptCount > 0 || reasons.length > 0

  return (
    <>
      {blocking ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {blocking.message}
        </div>
      ) : null}
      {hasNoticeRows ? (
        // Why bounded: one notice per partly-read session can outgrow the panel and hide the list.
        <div
          data-testid="ai-vault-scan-notices"
          className="scrollbar-sleek max-h-24 shrink-0 overflow-y-auto"
        >
          {notices.map((issue) => (
            <div
              // Include message identity: one host may report multiple notices for the same path.
              key={`${issue.executionHostId ?? 'local'}:${issue.kind}:${issue.agent}:${issue.path}:${issue.message}`}
              className={`border-b border-sidebar-border px-3 py-1.5 text-[11px] ${
                issue.kind === 'host' ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {issue.message}
            </div>
          ))}
          {skippedTranscriptCount > 0 ? (
            <div className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.AiVaultPanel.transcriptsSkipped',
                '{{count}} transcript skipped',
                { count: skippedTranscriptCount }
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
