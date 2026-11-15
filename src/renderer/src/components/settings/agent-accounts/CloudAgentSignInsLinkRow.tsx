// Neil: Orca Cloud's sign-ins moved from Settings › Agent accounts to Settings › Orca Cloud › Cloud
// agent sign-ins. This one row stays in Agent accounts so someone who looks there isn't lost.
import type React from 'react'
import { ArrowRight, Cloud } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

export function CloudAgentSignInsLinkRow({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      data-testid="cloud-agent-sign-ins-link"
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
      onClick={onOpen}
    >
      <Cloud aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(
          'settings.agentAccounts.cloudSignInsMoved',
          'Orca Cloud sign-ins live in Orca Cloud settings'
        )}
      </span>
      <ArrowRight aria-hidden className="size-4 shrink-0" />
    </button>
  )
}
