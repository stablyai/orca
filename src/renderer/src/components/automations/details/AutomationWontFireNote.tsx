import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { manageConnectors } from '@/components/bots/AddConnectorDialog'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled, useBotWebhooks } from '@/lib/bot-catalog'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { automationWontFire } from './automation-wont-fire'
import { AttentionDot } from '@/components/bots/AttentionDot'
import { useOrcaCloudSignedOut } from '../../bots/orca-cloud-signed-out'

type WontFireProps = { automation: Pick<Automation, 'bot' | 'on' | 'dtstart'> }

/** The host of the automation's bot, whose Orca Cloud says whether webhooks run. */
function automationBotHost(
  automation: WontFireProps['automation'],
  bots: readonly Bot[]
): ExecutionHostId | null {
  return bots.find((bot) => bot.id === automation.bot?.botId)?.hostId ?? null
}

/** A list row's dot beside the name, its reason in a tooltip. */
export function AutomationWontFireMark({
  automation,
  bots
}: WontFireProps & { bots: readonly Bot[] }): React.JSX.Element | null {
  const webhooks = useBotWebhooks(automationBotHost(automation, bots))
  const wontFire = automationWontFire(
    automation,
    useBotsEnabled() ? bots : [],
    webhooks,
    useOrcaCloudSignedOut()
  )
  if (!wontFire) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={wontFire.label}
          className="ml-1 flex size-4 shrink-0 items-center justify-center"
        >
          <AttentionDot />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {wontFire.label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The detail's quiet line under the title, with the way to add the connector. */
export function AutomationWontFireNote({ automation }: WontFireProps): React.JSX.Element | null {
  const t = useTranslate()
  const bots = useBots(useBotsEnabled())
  const wontFire = automationWontFire(
    automation,
    bots,
    useBotWebhooks(automationBotHost(automation, bots)),
    useOrcaCloudSignedOut()
  )
  if (!wontFire) {
    return null
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <AttentionDot />
      <span className="min-w-0 truncate">{wontFire.label}</span>
      {wontFire.needsConnector ? (
        <Button variant="link" size="xs" onClick={() => manageConnectors(wontFire.bot)}>
          {t('automations.openConnectors', 'Open connectors')}
        </Button>
      ) : null}
    </p>
  )
}
