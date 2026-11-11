// The Orca Cloud accounts policy (spec §5 item 5, the A1 mitigation) as a focusable info tooltip next
// to the section heading (JA-23). The text stays in the accessibility tree, so keyboard and
// screen-reader users still get it without opening the tooltip.
import type React from 'react'
import { Info } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function orcaCloudPolicyText(t: ReturnType<typeof useTranslate>): string {
  return [
    t('orcaCloudAccounts.activeDetail', 'Kept in your Orca account, never in a sandbox.'),
    t(
      'orcaCloudAccounts.policy',
      'Your Claude and ChatGPT accounts are used only in your own workspaces. Teammates never use them.'
    )
  ].join(' ')
}

export function OrcaCloudPolicyInfo(): React.JSX.Element {
  const t = useTranslate()
  const text = orcaCloudPolicyText(t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm align-middle text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          <Info aria-hidden className="size-3.5" />
          <span className="sr-only">{text}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
