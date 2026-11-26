// A connector setup that steps aside for its page in Orca's browser: the dialog stays mounted but out of
// the way, and a pill at the bottom of the window stands in until Expand, ✕, or the setup comes back.
import React, { useCallback, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { BotAppBrandLogo } from './apps/BotAppBrandLogo'
import { BotAppLogoBadge } from './apps/BotAppStepParts'

export function ConnectorSetupPill({
  connector,
  text,
  badge,
  done = false,
  stopLabel,
  onExpand,
  onStop
}: {
  connector: React.ComponentProps<typeof BotAppBrandLogo>['app']
  text: React.ReactNode
  badge: 'done' | 'waiting' | null
  /** Expand reads Review once the setup has something new to show. */
  done?: boolean
  /** Names the setup ✕ ends, e.g. "Stop adding Scout to Linear". */
  stopLabel: string
  onExpand: () => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const textId = useId()
  return createPortal(
    <div
      role="status"
      aria-labelledby={textId}
      data-connector-setup-surface=""
      className="fixed bottom-9 left-1/2 z-40 flex h-9 w-[min(372px,calc(100vw-24px))] -translate-x-1/2 items-center gap-1.5 rounded-xl border border-black/14 bg-popover pr-1 pl-0.5 text-[13px] text-popover-foreground shadow-floating dark:border-white/14"
    >
      <span aria-hidden className="relative shrink-0">
        <BotAppBrandLogo app={connector} />
        {badge ? <BotAppLogoBadge kind={badge} size="sm" /> : null}
      </span>
      <p id={textId} className="ml-0.5 flex min-w-0 flex-1 font-medium whitespace-pre">
        {text}
      </p>
      <Button size="sm" variant="ghost" onClick={onExpand}>
        {done ? t('bots.github.pill.review', 'Review') : t('bots.github.pill.expand', 'Expand')}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={stopLabel} onClick={onStop}>
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('bots.github.pill.stopTip', 'Stop')}</TooltipContent>
      </Tooltip>
    </div>,
    document.body
  )
}

/**
 * A setup dialog that steps aside to the pill while its page is open in Orca's browser, staying mounted
 * (hidden, non-modal) so its progress lives on; the setup calls `comeBack` once its page is done.
 */
export function useSetupStepAside(): {
  away: boolean
  stepAside: () => void
  comeBack: () => void
} {
  const [away, setAway] = useState(false)
  const stepAside = useCallback(() => setAway(true), [])
  const comeBack = useCallback(() => setAway(false), [])
  return { away, stepAside, comeBack }
}

/**
 * A connector's setup dialog that can step aside (useSetupStepAside): away, it stays mounted but hidden
 * and non-modal, so the page in Orca's browser is free, and the pill stands in for it. Only Close or
 * the pill's ✕ end it then.
 */
export function ConnectorSetupDialog({
  open,
  onOpenChange,
  aside,
  connector,
  service,
  botName,
  waiting,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  aside: ReturnType<typeof useSetupStepAside>
  connector: React.ComponentProps<typeof BotAppBrandLogo>['app']
  /** The service's name, e.g. "Linear". */
  service: string
  botName: string
  /** The page is still being waited on. */
  waiting: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog
      open={open}
      modal={!aside.away}
      onOpenChange={(next) => (aside.away && !next ? undefined : onOpenChange(next))}
    >
      {open && aside.away ? (
        <ConnectorSetupPill
          connector={connector}
          text={t('bots.connectorSetup.pill.adding', 'Adding {{name}} to {{service}}', {
            name: botName,
            service
          })}
          badge={waiting ? 'waiting' : null}
          stopLabel={t('bots.connectorSetup.pill.stop', 'Stop adding {{name}} to {{service}}', {
            name: botName,
            service
          })}
          onExpand={aside.comeBack}
          onStop={() => onOpenChange(false)}
        />
      ) : null}
      {/* It ends on who signed in and who gets access: a trust decision. */}
      <DialogContent surface="security" className={cn('sm:max-w-lg', aside.away && 'hidden')}>
        {open ? children : null}
      </DialogContent>
    </Dialog>
  )
}
