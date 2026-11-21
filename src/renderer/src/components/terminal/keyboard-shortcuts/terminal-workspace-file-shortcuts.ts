import { toast } from 'sonner'
import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import { useAppStore } from '../../../store/index'
import { translate } from '@/i18n/i18n'
import { createFloatingWorkspaceMarkdownTab } from '@/components/floating-terminal/workspace/floating-workspace-tab-creation'

type FileShortcutContext = {
  event: KeyboardEvent
  floatingWorkspaceFocused: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  notifyTerminalCapture: (actionId: KeybindingActionId) => void
  handleNewFile: () => Promise<void>
  handleNewNamedFile: () => Promise<void>
}

// Return false for unclaimed chords so remaining workspace shortcuts can handle them.
export function handleTerminalWorkspaceFileShortcut({
  event,
  floatingWorkspaceFocused,
  matchShortcut,
  notifyTerminalCapture,
  handleNewFile,
  handleNewNamedFile
}: FileShortcutContext): boolean {
  if (!event.repeat && matchShortcut('tab.newMarkdown')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newMarkdown')
    if (floatingWorkspaceFocused) {
      void createFloatingWorkspaceMarkdownTab(useAppStore.getState()).catch((error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.Terminal.f0600556b3',
                'Failed to create untitled markdown file.'
              )
        )
      })
      return true
    }
    void handleNewFile()
    return true
  }
  if (!event.repeat && matchShortcut('tab.newFile')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newFile')
    // The floating panel has no workspace folder to create the file in.
    if (!floatingWorkspaceFocused) {
      void handleNewNamedFile()
    }
    return true
  }
  return false
}
