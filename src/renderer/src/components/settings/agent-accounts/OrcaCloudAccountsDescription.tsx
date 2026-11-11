// JA-23 (design-squad): the A1 policy stays visible in the Orca Cloud description (spec §5 item 5,
// mandatory copy); only "Kept in your Orca account, never in a sandbox.", which every active row
// used to repeat, moves into a focusable info tooltip. Its text stays in the accessibility tree.
import type React from 'react'
import { Info } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The Orca Cloud section description: the help line, then the A1 policy, verbatim and visible. */
export function OrcaCloudAccountsDescription(): React.JSX.Element {
  const t = useTranslate()
  const kept = t('orcaCloudAccounts.activeDetail', 'Kept in your Orca account, never in a sandbox.')
  return (
    <>
      {t(
        'orcaCloudAccounts.help',
        'Set up once on this computer. Every cloud workspace uses it, including new, cloned and restarted ones.'
      )}{' '}
      {/* Mandatory (spec §5 item 5): the A1 mitigation depends on this sentence. */}
      {t(
        'orcaCloudAccounts.policy',
        'Your Claude and ChatGPT accounts are used only in your own workspaces. Teammates never use them.'
      )}{' '}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm align-middle text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            <Info aria-hidden className="size-3.5" />
            <span className="sr-only">{kept}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-xs">
          {kept}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
