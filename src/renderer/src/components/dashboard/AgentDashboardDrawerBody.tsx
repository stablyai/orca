import { useCallback, useState } from 'react'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { AgentSubjectReadIntent } from '@/attention/agent-subject-read-actions'
import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import type { AgentRevealArgs } from '../dashboard-popout/AgentTerminalDialog'
import { revealDashboardAgent } from './reveal-dashboard-agent'
import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'
import { useAgentDashboardTelemetry } from '../dashboard-popout/use-agent-dashboard-telemetry'
import { RunHistoryBrowser } from '../orchestration-history/RunHistoryBrowser'
import { translate } from '@/i18n/i18n'

type Props = {
  onClose: () => void
  onFocusHandoff: () => void
  onMenuOpenChange: (open: boolean) => void
}

export function AgentDashboardDrawerBody(props: Props): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false)
  return historyOpen ? (
    <RunHistoryBrowser
      onBack={() => setHistoryOpen(false)}
      onClose={props.onClose}
      onReveal={props.onFocusHandoff}
    />
  ) : (
    <AgentDashboardBoard {...props} onOpenHistory={() => setHistoryOpen(true)} />
  )
}

/** Mount only while open to keep live snapshot derivation off the closed path. */
function AgentDashboardBoard({
  onClose,
  onFocusHandoff,
  onMenuOpenChange,
  onOpenHistory
}: {
  onClose: () => void
  onFocusHandoff: () => void
  onMenuOpenChange: (open: boolean) => void
  onOpenHistory: () => void
}): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()
  useAgentDashboardTelemetry('in_window')

  // Pop-out IPC rejects this renderer; in-window reads/reveals must use the store directly.
  const handleAckAgent = useCallback((paneKey: string, intent: AgentSubjectReadIntent) => {
    useAppStore.getState().acknowledgeAgents([paneKey], undefined, intent)
  }, [])
  const handleRevealAgent = useCallback(
    (args: AgentRevealArgs) => {
      if (revealDashboardAgent(args)) {
        onFocusHandoff()
      } else {
        onClose()
      }
    },
    [onClose, onFocusHandoff]
  )

  // Hand off to pop-out mode instead of retaining a drawer inconsistent with the setting.
  const handleSwitchToPopout = useCallback(() => {
    onFocusHandoff()
    void window.api.dashboard.openPopout?.()
  }, [onFocusHandoff])

  return (
    <AgentKanbanBoard
      snapshot={snapshot}
      // Let the companion sheet’s sidebar surface show through.
      containerClassName="h-full w-full bg-transparent"
      onAckAgent={handleAckAgent}
      onRevealAgent={handleRevealAgent}
      onClose={onClose}
      headerActions={
        <>
          <Button variant="ghost" size="sm" onClick={onOpenHistory}>
            <History aria-hidden="true" />
            {translate('orchestrationHistory.title', 'Run history')}
          </Button>
          <AgentDashboardSettingsMenu
            onSwitchToPopout={handleSwitchToPopout}
            onOpenChange={onMenuOpenChange}
          />
        </>
      }
    />
  )
}
