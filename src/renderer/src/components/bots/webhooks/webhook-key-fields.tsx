// The URL and header-key lines the card and the Webhooks row share: masked until Reveal, copied without showing.
import React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import type { WebhookHostTarget } from './webhook-host-client'
import { useWebhookKey } from './use-webhook-key'

const MASK = '••••••••'
// A literal HTTP header, the same in every language.
const BEARER_HEADER = 'Authorization: Bearer'

/**
 * One labelled line: a fixed label column, the value, then its actions at the end. In a narrow
 * connectors panel the label sits above the value, and actions without room beside it wrap below.
 */
export function WebhookField(props: {
  label: string
  children: React.ReactNode
  actions?: React.ReactNode
  /** Literal values (URLs, keys, paths) are set in mono. */
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-h-7.5 items-center gap-2 @max-xs/connectors-panel:flex-wrap @max-xs/connectors-panel:gap-y-0 @max-xs/connectors-panel:pt-1">
      <span className="w-24 shrink-0 text-xs text-muted-foreground @max-xs/connectors-panel:w-full">
        {props.label}
      </span>
      {/* Literal values truncate on one line; words wrap, so a narrow card never cuts them off. */}
      <span
        className={cn(
          'min-w-0 flex-1 text-xs text-foreground @max-xs/connectors-panel:basis-24',
          props.mono ? 'truncate font-mono' : '[overflow-wrap:anywhere]'
        )}
      >
        {props.children}
      </span>
      {props.actions ? (
        <span className="-mr-1.5 flex shrink-0 items-center gap-0.5 @max-xs/connectors-panel:ml-auto">
          {props.actions}
        </span>
      ) : null}
    </div>
  )
}

/** URL (with Reveal where offered) and/or Header key, each with Copy. Mount with key={useWebhookKeyScope(…)}. */
export function WebhookKeyFields({
  target,
  summary,
  botName,
  canReveal,
  headerKey,
  url = true,
  disabled
}: {
  target: WebhookHostTarget
  summary: WebhookSummary
  botName: string
  canReveal: boolean
  /** The card also offers the key alone, for senders that take it as a header. */
  headerKey: boolean
  /** False where the URL has its own Copy URL beside it. */
  url?: boolean
  /** The host can't hand out the key now. */
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const keyControls = useWebhookKey({ target, hookId: summary.hookId, botName })
  const { revealed, busy } = keyControls
  const copyLabel = t('bots.webhooks.copy', 'Copy')
  return (
    <>
      {url ? (
        <WebhookField
          label={t('bots.webhooks.url', 'URL')}
          mono
          actions={
            <>
              {canReveal ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={disabled || busy}
                  onClick={revealed ? keyControls.hide : keyControls.reveal}
                >
                  {revealed ? t('bots.webhooks.hide', 'Hide') : t('bots.webhooks.reveal', 'Reveal')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled || busy}
                aria-label={t('bots.webhooks.copyUrl', 'Copy URL')}
                onClick={() => void keyControls.copy('url')}
              >
                {copyLabel}
              </Button>
            </>
          }
        >
          {revealed ? revealed.url : `${summary.url}/${MASK}`}
        </WebhookField>
      ) : null}
      {headerKey ? (
        <WebhookField
          label={t('bots.webhooks.headerKey', 'Header key')}
          mono
          actions={
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled || busy}
              aria-label={t('bots.webhooks.copyKey', 'Copy key')}
              onClick={() => void keyControls.copy('key')}
            >
              {copyLabel}
            </Button>
          }
        >
          {`${BEARER_HEADER} ${revealed ? revealed.key : MASK}`}
        </WebhookField>
      ) : null}
    </>
  )
}
