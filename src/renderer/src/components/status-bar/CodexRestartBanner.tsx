import { TriangleAlert } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { selectCodexRestartStatus } from './codex-restart-status-summary'
import { restartCodexAccountSessions } from '../terminal-pane/account-restart/codex-account-restart-execution'
import { useTranslate } from '@/i18n/use-translate'

/** Full-bleed prompt under the Codex header; clicking Restart answers every notice, so it simply disappears. */
export function CodexRestartBanner(): React.JSX.Element | null {
  const t = useTranslate()
  const { stalePtyIds, staleSessionCount, failures } = useAppStore(selectCodexRestartStatus)
  const count = failures.length + staleSessionCount
  const mixed = failures.length > 0 && staleSessionCount > 0

  if (count === 0) {
    return null
  }

  return (
    // Why: -mx cancels the menu surface's 6px plus the panel's 8px padding to reach both edges.
    <div
      role="status"
      className="-mx-[14px] border-y border-[color-mix(in_srgb,var(--status-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_14%,var(--popover))] px-3.5 py-2.5"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-status-warning-text" />
        <div className="min-w-0 flex-1 text-xs font-semibold leading-4 text-foreground">
          {mixed
            ? t(
                'auto.components.status.bar.StatusBar.codexRestartMixedTitle',
                '{{count}} Codex sessions need a restart.',
                { count, defaultValue_one: '{{count}} Codex session needs a restart.' }
              )
            : failures.length > 0
              ? t(
                  'auto.components.status.bar.StatusBar.codexRestartFailedTitle',
                  "{{count}} Codex sessions didn't restart.",
                  { count, defaultValue_one: "{{count}} Codex session didn't restart." }
                )
              : t(
                  'auto.components.status.bar.StatusBar.codexRestartBannerTitle',
                  '{{count}} Codex sessions still use the previous account.',
                  {
                    count: staleSessionCount,
                    defaultValue_one: '{{count}} Codex session still uses the previous account.'
                  }
                )}
        </div>
      </div>
      {/* Why: indent = icon (14px) + gap (8px), so the action lines up with the title. */}
      <div className="mt-2 flex pl-[22px]">
        {/* Why: Button wraps the menu item so its classes win the merge; arrow keys still reach it. */}
        <Button asChild variant="warning" size="menu">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              void restartCodexAccountSessions(stalePtyIds, failures)
            }}
          >
            {failures.length > 0 && !mixed
              ? t('auto.components.status.bar.StatusBar.codexRestartRetry', 'Retry')
              : t(
                  'auto.components.status.bar.StatusBar.codexRestartBannerAction',
                  'Restart sessions',
                  { count, defaultValue_one: 'Restart session' }
                )}
          </DropdownMenuItem>
        </Button>
      </div>
    </div>
  )
}
