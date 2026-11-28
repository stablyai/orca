// Opening the Needs you inbox: from the Bots section's button, or its shortcut from anywhere in the app
// (unbound until set in Settings > Shortcuts). The same shortcut closes it again.
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { textFieldClaimsActionKey } from '@/lib/keyboard/text-field-shortcut-policy'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'

const ACTION_ID = 'bots.needsYouInbox'

export function openBotsNeedsYouInbox(): void {
  useAppStore.getState().openModal('bots-needs-you')
}

export function useBotsNeedsYouInboxShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.key === 'Process' ||
        event.getModifierState('AltGraph') ||
        document.querySelector('[data-shortcut-recorder-active]')
      ) {
        return
      }
      const { keybindings, settings, activeModal } = useAppStore.getState()
      const context =
        event.target instanceof HTMLElement &&
        event.target.classList.contains('xterm-helper-textarea')
          ? 'terminal'
          : 'app'
      if (
        !keybindingMatchesAction(ACTION_ID, event, getShortcutPlatform(), keybindings, {
          context,
          terminalShortcutPolicy: settings?.terminalShortcutPolicy
        }) ||
        textFieldClaimsActionKey(event, ACTION_ID)
      ) {
        return
      }
      // Another dialog keeps the keyboard; the inbox's own shortcut closes it.
      if (activeModal !== 'none' && activeModal !== 'bots-needs-you') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (activeModal === 'bots-needs-you') {
        useAppStore.getState().closeModal()
      } else {
        openBotsNeedsYouInbox()
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [])
}
