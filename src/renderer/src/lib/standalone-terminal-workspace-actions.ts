import { toast } from 'sonner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

const HOME_RESOLUTION_ERROR =
  'Could not open the terminal because the home directory could not be resolved.'

function showHomeResolutionError(): void {
  toast.error(translate('auto.App.standaloneTerminalHomeResolutionFailed', HOME_RESOLUTION_ERROR))
}

export function activateStandaloneTerminalState(tabId: string): void {
  const store = useAppStore.getState()
  store.setActiveView('terminal')
  store.setActiveWorktree(FLOATING_TERMINAL_WORKTREE_ID)
  store.setActiveTabType('terminal')
  store.activateTab(tabId)
}

export async function createStandaloneTerminalAtHome(
  onActivateTerminal: (tabId: string) => void
): Promise<void> {
  let homeDirectory: string
  try {
    homeDirectory = await window.api.app.getFloatingTerminalCwd({ path: '~' })
  } catch (error) {
    console.error('Failed to resolve the home directory for a standalone terminal', error)
    showHomeResolutionError()
    return
  }
  if (!homeDirectory) {
    showHomeResolutionError()
    return
  }

  const store = useAppStore.getState()
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const tab = store.createTab(FLOATING_TERMINAL_WORKTREE_ID, targetGroupId, undefined, {
    activate: false,
    startupCwd: homeDirectory
  })
  onActivateTerminal(tab.id)
}
