import { useEffect } from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { useAppMenuPaste } from '@/hooks/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/useAppMenuSelectionActions'
import { translate } from '@/i18n/i18n'
import { AgentTerminalPreview } from '../dashboard-popout/AgentTerminalPreview'
import { useFloatingWorkspaceWindowSnapshot } from './use-floating-workspace-window-snapshot'

export function FloatingWorkspaceWindowRoot(): React.JSX.Element {
  // The window has no App shell to translate Edit-menu IPC into terminal ownership events.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  const activeTab = useFloatingWorkspaceWindowSnapshot()?.activeTab ?? null
  const paneKey = activeTab?.paneKey
  const status = activeTab?.status

  // Watching the focused window's active tab reads its agent state, as the dashboard pop-out's open card does.
  useEffect(() => {
    if (!paneKey) {
      return
    }
    const ack = (): void => {
      if (document.hasFocus()) {
        window.api.floatingWorkspaceWindow.ackAgent(paneKey, 'view')
      }
    }
    ack()
    window.addEventListener('focus', ack)
    return () => window.removeEventListener('focus', ack)
  }, [paneKey, status])

  const livePtyId = activeTab?.kind === 'terminal' ? activeTab.ptyId : null
  const placeholder = !activeTab
    ? translate('floatingWorkspaceWindow.empty', 'No terminal is open.')
    : activeTab.kind === 'other'
      ? translate('floatingWorkspaceWindow.otherTab', 'This tab opens in the main window.')
      : translate('floatingWorkspaceWindow.starting', 'Starting terminal...')

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {activeTab ? <AgentStateDot state={activeTab.status} /> : null}
        <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {activeTab?.title ?? ''}
        </h1>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => window.api.floatingWorkspaceWindow.requestDock()}
        >
          {translate('floatingWorkspaceWindow.dock', 'Dock')}
        </Button>
      </div>
      {livePtyId ? (
        <AgentTerminalPreview
          key={livePtyId}
          ptyId={livePtyId}
          terminalInput={activeTab?.terminalInput ?? null}
          className="h-auto min-h-0 flex-1"
          focusOnResync={false}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-2xs text-muted-foreground">
          {placeholder}
        </div>
      )}
    </div>
  )
}
