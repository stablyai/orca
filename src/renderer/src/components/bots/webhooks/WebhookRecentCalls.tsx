import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AutomationBotResultsTo } from '../../../../../shared/automations/automation-definition'
import type { WebhookCallRow } from '../../../../../shared/rpc-contract/webhooks-params'
import { NativeChatMessageTimestamp } from '../../native-chat/messages/rows/NativeChatMessageTimestamp'
import { BotConnectorCaption } from '../bot-connector-people'
import { useWebhookCalls } from './use-webhook-data'
import { webhookCallLine } from './webhook-call-copy'
import { webhookErrorMessage } from './webhook-copy'

// Closed lists show this many; Show all reveals the rest the host returned.
const SHOWN_CALLS = 5

function callTime(row: WebhookCallRow): number {
  return row.kind === 'call' ? row.receivedAt : row.minute
}

function rowKey(row: WebhookCallRow): string {
  return row.kind === 'call' ? row.callId : `${row.kind}:${row.minute}`
}

/** Recent calls: the cloud's verdict for each call, then what the bot's computer did with it. */
export function WebhookRecentCalls({
  target,
  hookId,
  botName,
  resultsTo
}: {
  target: RuntimeClientTarget
  hookId: string
  botName: string
  resultsTo: AutomationBotResultsTo
}): React.JSX.Element {
  const t = useTranslate()
  const read = useWebhookCalls(target, hookId)
  const [showAll, setShowAll] = useState(false)
  const calls = read.status === 'ready' ? read.value : []
  const shown = showAll ? calls : calls.slice(0, SHOWN_CALLS)
  return (
    <div className="mt-3">
      <BotConnectorCaption
        title={t('bots.webhooks.recentCalls', 'Recent calls')}
        count={read.status === 'ready' ? calls.length : undefined}
        action={
          calls.length > SHOWN_CALLS ? (
            <Button variant="ghost" size="xs" onClick={() => setShowAll((value) => !value)}>
              {showAll
                ? t('bots.webhooks.showFewer', 'Show fewer')
                : t('bots.webhooks.showAll', 'Show all')}
            </Button>
          ) : null
        }
      />
      {read.status === 'failed' ? (
        <p className="text-xs text-muted-foreground">
          {webhookErrorMessage(read.error, botName, target)}
        </p>
      ) : read.status === 'ready' && calls.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('bots.webhooks.noCalls', 'No calls yet.')}
        </p>
      ) : (
        // One shared time column, as wide as the longest time ("Yesterday 2:56 PM"); in a narrow
        // pane the time column gives way and wraps, so labels keep whole words.
        <ul className="grid grid-cols-[auto_minmax(min-content,6rem)_minmax(0,1fr)] gap-x-3">
          {shown.map((row) => {
            const line = webhookCallLine(row, botName, resultsTo)
            return (
              <li
                key={rowKey(row)}
                className="col-span-3 grid min-h-6 grid-cols-subgrid items-center text-xs"
              >
                <NativeChatMessageTimestamp
                  timestamp={callTime(row)}
                  className="whitespace-normal text-muted-foreground"
                />
                <span className="text-foreground">{line.label}</span>
                <span className="min-w-0 truncate text-muted-foreground">{line.detail}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
