import type React from 'react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'

const WAIT_FOR_EXPANSION = Symbol()

/** Updating restarts servers, so every update asks once, naming what restarts and whether live sessions drop. */
export function ServerRestartConfirm({
  servers,
  label,
  variant,
  disabled,
  disabledReason,
  expansion,
  onConfirm,
  focusAfterConfirm
}: {
  servers: RemoteServerUpdateEntry[]
  label: string
  variant: 'default' | 'outline'
  disabled: boolean
  disabledReason?: string
  expansion?: { expanded: boolean; failed: boolean; expand: () => void }
  /** Receives exactly the servers the question named. */
  onConfirm: (environmentIds: string[]) => void
  focusAfterConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirmed = useRef(false)
  const warningId = useId()
  const ids = servers.map((entry) => entry.environmentId)
  const key = ids.join('\n')
  // Bound to the servers it named: if the set changes while open, the question closes unanswered.
  const [openKey, setOpenKey] = useState<string | typeof WAIT_FOR_EXPANSION | null>(null)
  const awaitingExpansion = openKey === WAIT_FOR_EXPANSION
  const unavailable = expansion && disabled && !awaitingExpansion
  // Invalidation is durable: once the set changes or updates block, the question is dropped and
  // never reopens by itself.
  if (openKey === WAIT_FOR_EXPANSION) {
    if (!expansion?.expanded || expansion.failed) {
      setOpenKey(null)
    } else if (!disabled) {
      setOpenKey(key)
    }
  } else if (openKey !== null && (openKey !== key || disabled || expansion?.expanded === false)) {
    setOpenKey(null)
  }
  const open = openKey === key && !disabled && expansion?.expanded !== false
  const live = servers.some((entry) => entry.liveTabCount > 0 || entry.liveLeafCount > 0)
  const question =
    servers.length === 1
      ? t('settings.about.servers.confirmOne', 'Restart {{name}}?', { name: servers[0].name })
      : t('settings.about.servers.confirmMany', 'Restart {{count}} servers?', {
          count: servers.length
        })
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next || awaitingExpansion) {
          setOpenKey(null)
          return
        }
        if (disabled) {
          return
        }
        if (expansion?.expanded === false) {
          setOpenKey(WAIT_FOR_EXPANSION)
          expansion.expand()
          return
        }
        setOpenKey(key)
      }}
    >
      <span
        className="relative inline-flex data-disabled:opacity-50"
        data-disabled={unavailable ? '' : undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size="sm"
            disabled={!expansion && disabled}
            aria-disabled={unavailable || undefined}
            aria-busy={awaitingExpansion || undefined}
            aria-description={disabled ? disabledReason : undefined}
            title={disabled ? disabledReason : undefined}
            onBlur={() => {
              if (awaitingExpansion) {
                setOpenKey(null)
              }
            }}
            onKeyDown={(event) => {
              if (awaitingExpansion && event.key === 'Escape') {
                event.preventDefault()
                setOpenKey(null)
              }
            }}
          >
            {label}
          </Button>
        </PopoverTrigger>
        {/* Register after the trigger so the card-width anchor takes precedence. */}
        <PopoverAnchor asChild>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -end-[var(--about-card-inset)] w-[calc(100cqw_+_2*var(--about-card-inset))]"
          />
        </PopoverAnchor>
      </span>
      <PopoverContent
        side="top"
        align="end"
        aria-label={question}
        aria-describedby={live ? warningId : undefined}
        className="@container/server-confirm w-[min(30rem,var(--radix-popover-trigger-width))]"
        onCloseAutoFocus={(event) => {
          if (confirmed.current) {
            confirmed.current = false
            event.preventDefault()
            focusAfterConfirm()
          }
        }}
      >
        <div className="flex items-center gap-1 p-1.5 @min-[27rem]/server-confirm:gap-2 @min-[27rem]/server-confirm:ps-3">
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className={live ? 'hidden @min-[27rem]/server-confirm:inline' : undefined}>
              {question}
            </span>
            {live ? (
              <span id={warningId}>
                <span className="hidden @min-[27rem]/server-confirm:inline">
                  {' '}
                  {t('settings.about.servers.liveMayDrop', 'Live sessions may drop.')}
                </span>
                <span className="text-xs @min-[27rem]/server-confirm:hidden">
                  {t('settings.about.servers.sessionsMayDrop', 'Sessions may drop')}
                </span>
              </span>
            ) : null}
          </p>
          {/* Focus starts on Cancel so a repeated or held Enter can't restart servers. */}
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              autoFocus
              onClick={() => setOpenKey(null)}
            >
              {t('settings.about.servers.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => {
                confirmed.current = true
                setOpenKey(null)
                onConfirm(ids)
              }}
            >
              {t('settings.about.action.update', 'Update')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
