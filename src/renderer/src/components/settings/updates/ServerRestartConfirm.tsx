import type React from 'react'
import { useRef, useState } from 'react'
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
  expansion,
  onConfirm,
  focusAfterConfirm
}: {
  servers: RemoteServerUpdateEntry[]
  label: string
  variant: 'default' | 'outline'
  disabled: boolean
  expansion?: { expanded: boolean; failed: boolean; expand: () => void }
  /** Receives exactly the servers the question named. */
  onConfirm: (environmentIds: string[]) => void
  focusAfterConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirmed = useRef(false)
  const ids = servers.map((entry) => entry.environmentId)
  const key = ids.join('\n')
  // Bound to the servers it named: if the set changes while open, the question closes unanswered.
  const [openKey, setOpenKey] = useState<string | typeof WAIT_FOR_EXPANSION | null>(null)
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
        if (next && expansion?.expanded === false) {
          setOpenKey(WAIT_FOR_EXPANSION)
          expansion.expand()
          return
        }
        setOpenKey(next ? key : null)
      }}
    >
      <span className="relative inline-flex">
        <PopoverTrigger asChild>
          <Button type="button" variant={variant} size="sm" disabled={disabled}>
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
            {question}
            {live ? (
              <span className="hidden @min-[27rem]/server-confirm:inline">
                {' '}
                {t('settings.about.servers.liveMayDrop', 'Live sessions may drop.')}
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
