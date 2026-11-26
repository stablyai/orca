import type React from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'

/** Updating restarts servers, so every update asks once, naming what restarts and whether live sessions drop. */
export function ServerRestartConfirm({
  servers,
  label,
  variant,
  disabled,
  onConfirm
}: {
  servers: RemoteServerUpdateEntry[]
  label: string
  variant: 'default' | 'outline'
  disabled: boolean
  /** Receives exactly the servers the question named. */
  onConfirm: (environmentIds: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = servers.map((entry) => entry.environmentId)
  const key = ids.join('\n')
  // Bound to the servers it named: if the set changes while open, the question closes unanswered.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Invalidation is durable: once the set changes or updates block, the question is dropped and
  // never reopens by itself.
  if (openKey !== null && (openKey !== key || disabled)) {
    setOpenKey(null)
  }
  const open = openKey === key && !disabled
  const live = servers.some((entry) => entry.liveTabCount > 0 || entry.liveLeafCount > 0)
  const question =
    servers.length === 1
      ? t('settings.about.servers.confirmOne', 'Restart {{name}}?', { name: servers[0].name })
      : t('settings.about.servers.confirmMany', 'Restart {{count}} servers?', {
          count: servers.length
        })
  return (
    <Popover open={open} onOpenChange={(next) => setOpenKey(next ? key : null)}>
      <PopoverTrigger asChild>
        <Button type="button" variant={variant} size="sm" disabled={disabled}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={question}
        className="w-auto max-w-[min(30rem,calc(100vw-1rem))]"
      >
        <div className="flex items-center gap-3 p-1.5 ps-3">
          <p className="min-w-0 text-sm">
            {question}
            {live ? ` ${t('settings.about.servers.liveMayDrop', 'Live sessions may drop.')}` : null}
          </p>
          {/* Focus starts on Cancel so a repeated or held Enter can't restart servers. */}
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
              setOpenKey(null)
              onConfirm(ids)
            }}
          >
            {t('settings.about.action.update', 'Update')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
