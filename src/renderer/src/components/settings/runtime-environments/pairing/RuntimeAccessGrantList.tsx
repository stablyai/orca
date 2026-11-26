import { useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { Button } from '../../../ui/button'
import { cn } from '@/lib/class-names'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { LegacyEncryptionNotice } from '../../legacy-encryption-notice'

function formatAccessTimestamp(timestamp: number, intlLocale: string = getIntlLocale()): string {
  return new Intl.DateTimeFormat(intlLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

// Why: main names each link "Runtime <date>"; show it as a link, not a runtime.
function grantDisplayName(
  grant: RuntimeAccessGrant,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  return /^Runtime \d/.test(grant.name)
    ? t('auto.components.settings.RuntimeAccessGrantList.linkName', 'Link · {{value0}}', {
        value0: new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric' }).format(
          new Date(grant.createdAt)
        )
      })
    : grant.name
}

type ScrollEdges = { above: boolean; below: boolean }

function readScrollEdges(el: HTMLElement, current: ScrollEdges): ScrollEdges {
  const next = {
    above: el.scrollTop > 1,
    below: el.scrollTop + el.clientHeight < el.scrollHeight - 1
  }
  return next.above === current.above && next.below === current.below ? current : next
}

/**
 * Caps the rows at ~3.5 (56px row + 8px gap) and fades only the edges that hide rows.
 * Why a separate component: edge state lives here, so a fade change re-renders only this
 * wrapper; the row elements arrive as the same `children` and React skips them.
 */
function ActiveLinksScroller({
  capped,
  children
}: {
  capped: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ above: false, below: false })

  // Why: measure before paint so a capped list never flashes a hard cut. Rows change on revoke
  // and refresh (new children); the box changes when the window narrows.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) {
      return
    }
    const update = (): void => setEdges((current) => readScrollEdges(el, current))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [children])

  return (
    // Why: scroll-py-4 keeps a focused Revoke clear of the 1rem fades when Tab scrolls to it.
    <div
      ref={listRef}
      onScroll={(event) => {
        const el = event.currentTarget
        setEdges((current) => readScrollEdges(el, current))
      }}
      className={cn(
        'space-y-2',
        capped && 'scrollbar-sleek max-h-[13.75rem] scroll-py-4 overflow-y-auto',
        edges.above &&
          edges.below &&
          '[mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-1rem),transparent)]',
        edges.above &&
          !edges.below &&
          '[mask-image:linear-gradient(to_bottom,transparent,black_1rem)]',
        !edges.above &&
          edges.below &&
          '[mask-image:linear-gradient(to_bottom,black_calc(100%-1rem),transparent)]'
      )}
    >
      {children}
    </div>
  )
}

type RuntimeAccessGrantListProps = {
  className?: string
  grants: RuntimeAccessGrant[]
  currentGrantId: string | null
  isLoading: boolean
  revokingGrantId: string | null
  onRevoke: (grant: RuntimeAccessGrant) => void
}

export function RuntimeAccessGrantList({
  className,
  grants,
  currentGrantId,
  isLoading,
  revokingGrantId,
  onRevoke
}: RuntimeAccessGrantListProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">
          {t('auto.components.settings.RuntimeAccessGrantList.activeLinks', 'Active links')}
        </h3>
      </div>

      {grants.length === 0 && isLoading ? null : grants.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('auto.components.settings.RuntimeAccessGrantList.noActiveLinks', 'No active links.')}
        </p>
      ) : (
        // Why: links pile up over time; past 3 the list scrolls under a fixed heading. Up to 3
        // always show in full, even when notices make their rows taller than the cap.
        <ActiveLinksScroller capped={grants.length > 3}>
          {grants.map((grant) => {
            const isCurrent = currentGrantId === grant.deviceId
            const isRevoking = revokingGrantId === grant.deviceId
            return (
              <div
                key={grant.deviceId}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {grantDisplayName(grant, t, intlLocale)}
                    </span>
                    {isCurrent ? (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {t(
                          'auto.components.settings.RuntimeAccessGrantList.434e4a6af6',
                          'Current link'
                        )}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {t(
                      'auto.components.settings.RuntimeAccessGrantList.createdAt',
                      'Created {{value0}}',
                      { value0: formatAccessTimestamp(grant.createdAt, intlLocale) }
                    )}
                    {' · '}
                    {grant.lastSeenAt
                      ? t(
                          'auto.components.settings.RuntimeAccessGrantList.b18d1764ef',
                          'Last used {{value0}}',
                          { value0: formatAccessTimestamp(grant.lastSeenAt, intlLocale) }
                        )
                      : t(
                          'auto.components.settings.RuntimeAccessGrantList.df142657a5',
                          'Not used yet'
                        )}
                  </div>
                  {grant.usesLegacyEncryption ? (
                    <LegacyEncryptionNotice
                      message={t(
                        'auto.components.settings.RuntimeAccessGrantList.legacyEncryption',
                        'Last used with older encryption. Update Orca where this link is used.'
                      )}
                    />
                  ) : grant.olderPairingMethod ? (
                    <div className="text-muted-foreground text-xs">
                      {t(
                        'auto.components.settings.RuntimeAccessGrantList.olderPairingMethod',
                        'Uses an older pairing method. Update Orca on the device that uses this link.'
                      )}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onRevoke(grant)}
                  disabled={isRevoking}
                  aria-label={t(
                    'auto.components.settings.RuntimeAccessGrantList.6f6d5188ed',
                    'Revoke {{value0}}',
                    { value0: grantDisplayName(grant, t, intlLocale) }
                  )}
                >
                  {isRevoking ? <Loader2 className="animate-spin" /> : null}
                  {t('auto.components.settings.RuntimeAccessGrantList.revoke', 'Revoke')}
                </Button>
              </div>
            )
          })}
        </ActiveLinksScroller>
      )}
      {grants.length > 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">
          {t(
            'auto.components.settings.RuntimeAccessGrantList.sshAccessCaveat',
            'Revoking a link also revokes links made in terminals it opened. Anyone with a terminal on this computer, over SSH or through a link, can still pair again.'
          )}
        </p>
      ) : null}
    </div>
  )
}
