import { useAppStore } from '../../store'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import {
  firesNativePasteEvent,
  getClipboardEventText,
  isClipboardEventPasteRequired
} from './terminal-clipboard-event-paste'
import { assertClipboardTextWithinLimitWithYield } from '../../../../shared/clipboard-text'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'
import { isEditableTarget } from '@/lib/editable-target'
import { copyTerminalSelection } from './terminal-selection-copy'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import {
  formatClipboardImagePasteError,
  type TerminalPanePasteExecution
} from './terminal-pane-paste-execution'

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

function isInsideNativeChatRoot(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null
}

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
  const {
    forceBracketedMultilineTextPaste,
    keybindings,
    managerRef,
    setTerminalError,
    worktreeId
  } = controller
  const { executePanePasteText, pasteFromClipboard } = execution
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
      isInsideNativeChatRoot(target)
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
      isInsideNativeChatRoot(target)
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
    const activeElementAtDispatch = document.activeElement
    if (
      !(activeElementAtDispatch instanceof Element) ||
      !container.contains(activeElementAtDispatch) ||
      activeElementAtDispatch.closest('[data-terminal-search-root]') ||
      isInsideNativeChatRoot(activeElementAtDispatch)
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
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      useAppStore.getState(),
      worktreeId
    )
    void pasteTerminalClipboard({
      readClipboardText: window.api.ui.readClipboardText,
      saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
      connectionId,
      runtimeEnvironmentId,
      forceBracketedMultilineTextPaste,
      pasteText: (text, options) =>
        executePanePasteText(pane, 'app-menu', activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
    }).catch(() => setTerminalError('Paste failed.'))
  }

  const onAppMenuSelectionAction = (event: Event): void => {
    const activeElement = document.activeElement
    if (
      !(activeElement instanceof Element) ||
      !container.contains(activeElement) ||
      isEditableTarget(activeElement) ||
      activeElement.closest('[data-terminal-search-root]') ||
      isInsideNativeChatRoot(activeElement)
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
  container.addEventListener('paste', onPaste, { capture: true })
  window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
  window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  return () => {
    if (pasteSuppressionTimerId !== null) {
      window.clearTimeout(pasteSuppressionTimerId)
    }
    container.removeEventListener('keydown', onKeyPaste, { capture: true })
    container.removeEventListener('paste', onPaste, { capture: true })
    window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  }
}
