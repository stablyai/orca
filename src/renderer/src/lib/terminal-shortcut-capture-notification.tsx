import { Keyboard } from 'lucide-react'
import { toast } from 'sonner'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  isKeybindingPotentialTerminalConflict,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { useAppStore } from '../store'

const STORAGE_PREFIX = 'orca.terminalShortcutCapturedNotice.'

function hasShownNotice(actionId: KeybindingActionId): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${actionId}`) === 'true'
  } catch {
    return false
  }
}

function markNoticeShown(actionId: KeybindingActionId): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${actionId}`, 'true')
  } catch {
    // Ignore storage failures; the notification still gives the user the path.
  }
}

function openShortcutSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'shortcuts',
    repoId: null,
    sectionId: 'terminal-shortcut-policy'
  })
}

export function showTerminalShortcutCaptureNotification({
  actionId,
  platform,
  keybindings
}: {
  actionId: KeybindingActionId
  platform: NodeJS.Platform
  keybindings?: KeybindingOverrides
}): void {
  const definition = getKeybindingDefinition(actionId)
  if (!definition || !isKeybindingPotentialTerminalConflict(definition)) {
    return
  }
  if (hasShownNotice(actionId)) {
    return
  }
  markNoticeShown(actionId)

  const bindingLabel = formatKeybindingList(
    getEffectiveKeybindingsForAction(actionId, platform, keybindings),
    platform
  )
  toast.message('Orca handled a terminal shortcut', {
    description: `${definition.title} (${bindingLabel}) can be changed in Keyboard Shortcuts.`,
    icon: <Keyboard className="size-4 text-muted-foreground" />,
    action: {
      label: 'Open Shortcuts',
      onClick: openShortcutSettings
    }
  })
}
