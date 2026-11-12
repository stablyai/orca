import { useAppStore } from '../../../../store/index'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { resolveTerminalPasteRuntimeEnvironmentId } from './terminal-paste-runtime'
import '../../../../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import {
  firesNativePasteEvent,
  getClipboardEventText,
  isClipboardEventPasteRequired
} from '../../clipboard/terminal-clipboard-event-paste'
import { assertClipboardTextWithinLimitWithYield } from '../../../../../../shared/clipboard-text'
import { pasteTerminalClipboard } from '../../clipboard/terminal-clipboard-paste'
import { APP_MENU_PASTE_EVENT } from '@/lib/clipboard/menu/app-menu-paste'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-commands/app-menu-selection-actions'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { copyTerminalSelection } from '../../clipboard/terminal-selection-copy'
import { isInsideNativeChatCover } from '../../chat/native-chat-covered-pane'
import type { TerminalPaneCloseController } from '../../layout/close/use-terminal-pane-close-actions'
import {
  formatClipboardImagePasteError,
  type TerminalPanePasteExecution
} from './terminal-pane-paste-execution'

export function registerTerminalPanePasteListeners({
  container,
  controller,
  execution,
  isMac,
  shortcutPlatform
}: {
  container: HTMLDivElement
  controller: TerminalPaneCloseController
  execution: TerminalPanePasteExecution
  isMac: boolean
  shortcutPlatform: NodeJS.Platform
}): () => void {
  const { keybindings, managerRef, paneTransportsRef, setTerminalError, worktreeId } = controller
  const {
    clipboardImageEnterHold,
    createPaneClipboardCopiedFiles,
    executePanePasteText,
    pasteFromClipboard,
    resolvePaneProtectedMultilinePasteOptions
  } = execution
  let suppressNextNativePaste = false
  let pasteSuppressionTimerId: number | null = null
  const shouldSuppressNativePaste = (event: KeyboardEvent): boolean => {
    const key = event.key.toLowerCase()
    return (
      (isMac &&
        key === 'v' &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey) ||
      (!isMac && key === 'v' && event.ctrlKey && !event.metaKey && !event.altKey) ||
      (!isMac &&
        event.key === 'Insert' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey)
    )
  }
  const onKeyPaste = (event: KeyboardEvent): void => {
    const target = event.target
    if (
      (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
      isInsideNativeChatCover(target)
    ) {
      return
    }
    const matchesPaste = keybindingMatchesAction(
      'terminal.paste',
      event,
      shortcutPlatform,
      keybindings,
      { context: 'terminal' }
    )
    if (!matchesPaste) {
      if (shouldSuppressNativePaste(event)) {
        suppressNextNativePaste = true
        if (pasteSuppressionTimerId !== null) {
          window.clearTimeout(pasteSuppressionTimerId)
        }
        pasteSuppressionTimerId = window.setTimeout(() => {
          pasteSuppressionTimerId = null
          suppressNextNativePaste = false
        }, 0)
      }
      return
    }
    if (isClipboardEventPasteRequired() && firesNativePasteEvent(event, isMac)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    suppressNextNativePaste = true
    if (pasteSuppressionTimerId !== null) {
      window.clearTimeout(pasteSuppressionTimerId)
    }
    pasteSuppressionTimerId = window.setTimeout(() => {
      pasteSuppressionTimerId = null
      suppressNextNativePaste = false
    }, 0)
    pasteFromClipboard(pane, 'keyboard')
  }

  const onPaste = (event: ClipboardEvent): void => {
    const target = event.target
    if (
      (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
      isInsideNativeChatCover(target)
    ) {
      return
    }
    if (suppressNextNativePaste) {
      suppressNextNativePaste = false
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
        pasteSuppressionTimerId = null
      }
      event.preventDefault()
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    if (isClipboardEventPasteRequired()) {
      const eventText = getClipboardEventText(event)
      pasteFromClipboard(pane, 'paste-event', (options) =>
        assertClipboardTextWithinLimitWithYield(eventText, options)
      )
      return
    }
    pasteFromClipboard(pane, 'paste-event')
  }

  const onAppMenuPaste = (event: Event): void => {
    if (event.defaultPrevented) {
      return
    }
    const activeElementAtDispatch = document.activeElement
    if (
      !(activeElementAtDispatch instanceof Element) ||
      !container.contains(activeElementAtDispatch) ||
      activeElementAtDispatch.closest('[data-terminal-search-root]') ||
      isInsideNativeChatCover(activeElementAtDispatch)
    ) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    const connectionId = getConnectionId(worktreeId) ?? null
    const runtimeEnvironmentId = resolveTerminalPasteRuntimeEnvironmentId(
      useAppStore.getState(),
      worktreeId,
      paneTransportsRef.current.get(pane.id)
    )
    void pasteTerminalClipboard({
      readClipboardText: window.api.ui.readClipboardText,
      saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
      copiedFiles: createPaneClipboardCopiedFiles(pane),
      connectionId,
      runtimeEnvironmentId,
      protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
      pasteText: (text, options) =>
        executePanePasteText(pane, 'app-menu', activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error)),
      onImagePasteUploadStart: () => clipboardImageEnterHold.noteImageUploadStart(pane.id)
    })
      .then((result) =>
        clipboardImageEnterHold.settleImageUpload(
          pane.id,
          result.status === 'pasted' && result.kind === 'image-path'
        )
      )
      .catch(() => {
        clipboardImageEnterHold.settleImageUpload(pane.id, false)
        setTerminalError('Paste failed.')
      })
  }

  const onAppMenuSelectionAction = (event: Event): void => {
    const activeElement = document.activeElement
    if (
      !(activeElement instanceof Element) ||
      !container.contains(activeElement) ||
      isEditableTarget(activeElement) ||
      activeElement.closest('[data-terminal-search-root]') ||
      isInsideNativeChatCover(activeElement)
    ) {
      return
    }
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (!pane) {
      return
    }
    const action = (event as CustomEvent<AppMenuSelectionAction>).detail
    if (action === 'copy') {
      if (!pane.terminal.getSelection()) {
        return
      }
      event.preventDefault()
      void copyTerminalSelection({
        terminal: pane.terminal,
        writeClipboardText: window.api.ui.writeTerminalClipboardText
      }).catch(() => undefined)
      return
    }
    if (action === 'select-all') {
      event.preventDefault()
      pane.terminal.selectAll()
    }
  }

  container.addEventListener('keydown', onKeyPaste, { capture: true })
  container.addEventListener('keydown', clipboardImageEnterHold.handleKeyDown, { capture: true })
  container.addEventListener('paste', onPaste, { capture: true })
  window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
  window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  return () => {
    if (pasteSuppressionTimerId !== null) {
      window.clearTimeout(pasteSuppressionTimerId)
    }
    container.removeEventListener('keydown', onKeyPaste, { capture: true })
    container.removeEventListener('keydown', clipboardImageEnterHold.handleKeyDown, {
      capture: true
    })
    container.removeEventListener('paste', onPaste, { capture: true })
    window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  }
}
