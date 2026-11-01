import { useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { aiVaultAgentLabel, type AiVaultScanIssue } from '../../../../shared/ai-vault-types'
import { aiVaultScanIssueDisplayText } from './ai-vault-scan-issue-copy'
import { aiVaultScanIssueIdentity } from './ai-vault-scan-issue-state'

export function AiVaultScanNotices({ issues }: { issues: AiVaultScanIssue[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const visibleIssues = issues.filter((issue) => !dismissed.has(aiVaultScanIssueIdentity(issue)))
  if (visibleIssues.length === 0) {
    return null
  }
  const dismissLabel = translate('aiVault.scanIssues.dismissNotices', 'Dismiss history notices')
  return (
    <div className="shrink-0 border-b border-sidebar-border text-xs text-muted-foreground">
      <Collapsible>
        <div className="flex items-center gap-1 px-3 py-1">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="group min-w-0 flex-1 justify-start">
              <ChevronDown className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              <span className="truncate">
                {translate('aiVault.scanIssues.noticesCount', 'History notices · {{count}}', {
                  count: visibleIssues.length
                })}
              </span>
            </Button>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={dismissLabel}
                onClick={() =>
                  setDismissed(
                    (previous) =>
                      new Set([...previous, ...visibleIssues.map(aiVaultScanIssueIdentity)])
                  )
                }
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{dismissLabel}</TooltipContent>
          </Tooltip>
        </div>
        <CollapsibleContent>
          <div className="scrollbar-sleek max-h-32 overflow-y-auto px-3 pb-2">
            {visibleIssues.map((issue) => (
              <div
                key={aiVaultScanIssueIdentity(issue)}
                className="space-y-1 py-1 break-words [overflow-wrap:anywhere]"
              >
                <div className="font-medium">
                  {aiVaultAgentLabel(issue.agent)} ·{' '}
                  {issue.executionHostId ??
                    translate('sessionHistory.settings.thisComputer', 'This computer')}
                </div>
                <p>{aiVaultScanIssueDisplayText(issue)}</p>
                {issue.path ? <p className="font-mono text-2xs">{issue.path}</p> : null}
                {issue.messageDetail ? <p className="text-2xs">{issue.messageDetail}</p> : null}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
