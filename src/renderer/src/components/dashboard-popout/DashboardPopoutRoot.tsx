import { useState } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppMenuPaste } from '@/hooks/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/useAppMenuSelectionActions'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { useDashboardSnapshot } from './useDashboardSnapshot'

/**
 * Root of the pop-out dashboard window. Subscribes to the live snapshot relayed
 * from the main window and renders the agent board.
 */
export function DashboardPopoutRoot(): React.JSX.Element {
  // Why: this window has no App shell, so nothing else would translate the
  // Edit-menu IPC into the ownership events the terminal preview claims.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  const snapshot = useDashboardSnapshot()
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const openAgentsInApp = snapshot.openAgentsInApp === true
  const setOpenAgentsInApp = async (checked: boolean): Promise<void> => {
    setSaving(true)
    setSaveFailed(false)
    try {
      await window.api.settings.set({ experimentalAgentDashboardOpenInApp: checked })
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <AgentKanbanBoard
      snapshot={snapshot}
      openAgentsInApp={openAgentsInApp}
      headerActions={
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'dashboardPopout.settingsLabel',
                    'Agent Dashboard settings'
                  )}
                >
                  <Settings />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {translate('dashboardPopout.settingsTooltip', 'Board settings')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={openAgentsInApp}
              disabled={saving}
              onCheckedChange={(checked) => void setOpenAgentsInApp(checked)}
              onSelect={(event) => event.preventDefault()}
            >
              {translate('dashboardPopout.settings.openInApp', 'Open agents in main window')}
            </DropdownMenuCheckboxItem>
            <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">
              {translate(
                'dashboardPopout.settings.openInAppCopy',
                'Agent clicks in the pop-out open their workspace and terminal in the main window, leaving the dashboard in place.'
              )}
            </p>
            {saveFailed ? (
              <p role="alert" className="px-2 py-1 text-xs text-destructive">
                {translate(
                  'dashboardPopout.settings.saveFailed',
                  'Could not save dashboard settings'
                )}
              </p>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  )
}
