import { AlertTriangle, Check } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { HostAgentSignInView } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { refreshHostAgentSignInStatus } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../ui/tooltip'
import { openHostAgentSignInDialog } from './host-agent-sign-in-dialog-state'
import { useHostAgentSignInView } from './use-host-agent-sign-in-view'

const CHIP_CLASS =
  'flex shrink-0 items-center gap-1 rounded border border-border bg-accent px-1.5 py-px text-3xs leading-4 text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** One chip per installed agent; any chip opens the sign-in step. Nothing shows until the host answers. */
export function HostAgentSignInChipList({
  view,
  onOpen,
  onRetry
}: {
  view: HostAgentSignInView
  onOpen: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (view.phase === 'failed' && !view.report) {
    return (
      <button type="button" className={CHIP_CLASS} onClick={onRetry}>
        <AlertTriangle className="size-2.5 text-status-warning" />
        {t('accounts.hostAgentSignIn.chipCheckFailed', 'Couldn’t check agents · Retry')}
      </button>
    )
  }
  const report = 'report' in view ? view.report : null
  const agents = report?.agents.filter((entry) => entry.state !== 'notInstalled') ?? []
  if (agents.length === 0) {
    return null
  }
  return (
    <>
      {agents.map((entry) => {
        const label = getAgentLabel(entry.agent)
        const signedIn = entry.state === 'signedIn'
        const tooltip = signedIn
          ? entry.method === 'apiKey'
            ? t('accounts.hostAgentSignIn.chipApiKeyTooltip', '{{agent}} uses an API key here.', {
                agent: label
              })
            : t('accounts.hostAgentSignIn.chipSignedInTooltip', '{{agent}} is signed in here.', {
                agent: label
              })
          : entry.state === 'signedOut'
            ? t(
                'accounts.hostAgentSignIn.chipSignedOutTooltip',
                '{{agent}} isn’t signed in here. Click to sign in.',
                { agent: label }
              )
            : t(
                'accounts.hostAgentSignIn.chipUnknownTooltip',
                'Couldn’t tell if {{agent}} is signed in here.',
                { agent: label }
              )
        return (
          <Tooltip key={entry.agent}>
            <TooltipTrigger asChild>
              <button type="button" className={CHIP_CLASS} onClick={onOpen}>
                <AgentIcon agent={entry.agent} size={10} />
                <span>{label}</span>
                {signedIn ? (
                  <Check className="size-2.5" aria-hidden />
                ) : (
                  <span className={cn(entry.state === 'signedOut' && 'text-status-warning')}>
                    {entry.state === 'signedOut'
                      ? t('accounts.hostAgentSignIn.chipSignIn', 'Sign in')
                      : t('accounts.hostAgentSignIn.chipUnknown', 'Unknown')}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}

/** Sign-in chips for a paired host; asks only while it is reachable, so a sleeping VM stays asleep. */
export function HostAgentSignInChips({
  environmentId,
  hostLabel,
  reachable
}: {
  environmentId: string
  hostLabel: string
  reachable: boolean
}): React.JSX.Element | null {
  const view = useHostAgentSignInView(environmentId, reachable)
  return (
    <HostAgentSignInChipList
      view={view}
      onOpen={() => openHostAgentSignInDialog({ environmentId, hostLabel })}
      onRetry={() => void refreshHostAgentSignInStatus(environmentId, { force: true })}
    />
  )
}
