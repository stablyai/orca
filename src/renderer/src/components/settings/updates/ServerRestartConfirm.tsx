import type React from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { middleEllipsis } from '@/lib/middle-ellipsis'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'

const WAIT_FOR_EXPANSION = Symbol()
const NAME_TOKEN = '\u0000'

function ServerNameWithSuffix({
  name,
  suffix
}: {
  name: string
  suffix: string
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const fullNameRef = useRef<HTMLSpanElement>(null)
  const [visibleName, setVisibleName] = useState(name)

  useLayoutEffect(() => {
    const element = ref.current
    const fullName = fullNameRef.current
    if (!element || !fullName) {
      return
    }
    const probe = element.ownerDocument.createElement('span')
    probe.className = 'invisible absolute w-max'
    const fitName = (): void => {
      const width = element.getBoundingClientRect().width
      if (width === 0 || fullName.getBoundingClientRect().width <= width) {
        setVisibleName(name)
        return
      }
      // Measure in the dialog's own typography so the suffix fits beside the last visible glyph.
      element.append(probe)
      const fits = (candidate: string): boolean => {
        probe.textContent = `${candidate}${suffix}`
        return probe.getBoundingClientRect().width <= width
      }
      setVisibleName(fits('…') ? middleEllipsis(name, fits) : '')
    }
    fitName()
    const observer = new ResizeObserver(fitName)
    observer.observe(element)
    observer.observe(fullName)
    return () => {
      observer.disconnect()
      probe.remove()
    }
  }, [name, suffix])

  return (
    <span ref={ref} title={name} className="relative min-w-0 overflow-hidden whitespace-nowrap">
      {/* Keep the available width independent of the display name after truncation. */}
      <span ref={fullNameRef} aria-hidden className="invisible inline-block">
        {`${name}${suffix}`}
      </span>
      <span className="absolute inset-0 overflow-hidden">{`${visibleName}${suffix}`}</span>
    </span>
  )
}

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
  const serverName = servers.length === 1 ? servers[0].name : undefined
  const question =
    serverName !== undefined
      ? t('settings.about.servers.confirmOne', 'Restart {{name}}?', { name: NAME_TOKEN })
      : t('settings.about.servers.confirmMany', 'Restart {{count}} servers?', {
          count: servers.length
        })
  // Keep the translated punctuation and word order when the visible name has to truncate.
  const nameParts = question.split(NAME_TOKEN)
  const [beforeName, afterName] = nameParts.length === 2 ? nameParts : ['Restart ', '?']
  const accessibleQuestion =
    serverName === undefined ? question : `${beforeName}${serverName}${afterName}`
  const trigger = (
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
  )
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
        {/* Show the full host on keyboard focus before the compact confirmation opens. */}
        {serverName !== undefined && !expansion ? (
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-xs break-words">
              {serverName}
            </TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
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
        aria-label={accessibleQuestion}
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
          <p className="flex min-w-0 flex-1 items-baseline gap-1 text-sm">
            <span
              className={
                live
                  ? 'hidden min-w-0 overflow-hidden @min-[27rem]/server-confirm:flex'
                  : 'flex min-w-0 overflow-hidden'
              }
            >
              {serverName === undefined ? (
                <span className="truncate">{question}</span>
              ) : (
                <>
                  <span className="shrink-0 whitespace-pre">{beforeName}</span>
                  <ServerNameWithSuffix name={serverName} suffix={afterName} />
                </>
              )}
            </span>
            {live ? (
              <span id={warningId} className="shrink-0 whitespace-nowrap">
                <span className="hidden @min-[27rem]/server-confirm:inline">
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
              size="responsive-sm"
              autoFocus
              onClick={() => setOpenKey(null)}
            >
              {t('settings.about.servers.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="responsive-sm"
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
