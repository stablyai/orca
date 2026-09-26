import { Suspense } from 'react'
import { useAppStore } from '@/store'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_TOP_CHROME_HEIGHT } from '../sidebar/workspace-chrome-metrics'

const AgentDashboardInWindowBoard = lazyWithRetry(() =>
  import('./AgentDashboardInWindowBoard').then((module) => ({
    default: module.AgentDashboardInWindowBoard
  }))
)

const ignoreMenuChange = (): void => {}

/** Only the visible dock subscribes to live agent snapshots. */
export function AgentDashboardDock({
  reserveTitlebarSpace
}: {
  reserveTitlebarSpace: boolean
}): React.JSX.Element | null {
  const visible = useAppStore(
    (s) =>
      s.settings?.experimentalAgentDashboardPopout === true &&
      s.settings.experimentalAgentDashboardMode !== 'popout' &&
      s.settings.experimentalAgentDashboardDocked === true &&
      s.agentDashboardDrawerOpen &&
      // Match the full-page navigation exclusions in useAppChromeLayout.
      s.activeView !== 'settings' &&
      s.activeView !== 'activity' &&
      s.activeView !== 'space'
  )
  const setOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  if (!visible) {
    return null
  }

  return (
    <section
      aria-label={translate('dashboardPopout.dockedLabel', 'Docked Agent Dashboard')}
      data-agent-dashboard-dock=""
      className="flex min-h-0 shrink-0 flex-col border-b border-border bg-background"
      style={{
        height: 'min(360px, 45vh)',
        // Keep the floating sidebar controls and native window buttons above the board.
        marginTop: reserveTitlebarSpace ? WORKSPACE_TOP_CHROME_HEIGHT : undefined
      }}
    >
      <Suspense fallback={null}>
        <AgentDashboardInWindowBoard
          onClose={() => setOpen(false)}
          onMenuOpenChange={ignoreMenuChange}
          closeOnReveal={false}
        />
      </Suspense>
    </section>
  )
}
