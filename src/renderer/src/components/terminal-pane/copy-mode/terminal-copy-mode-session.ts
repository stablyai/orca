import { toast } from 'sonner'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { markTerminalFollowOutput } from '@/lib/pane-manager/terminal-scroll/terminal-scroll-intent'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { DEFAULT_TERMINAL_COPY_MODE_CONFIG } from '../../../../../shared/terminal/input/terminal-copy-mode-config'
import { paneIsCoveredByNativeChat } from '../chat/native-chat-covered-pane'
import { hasPendingTerminalImeComposition } from '../input/ime/terminal-ime-composition-route'
import { createTerminalCopyModeView, type TerminalCopyModeView } from './terminal-copy-mode-view'

type TerminalCopyModeSession = { pane: ManagedPane; view: TerminalCopyModeView }

export function copyModeSessionOwns(
  session: TerminalCopyModeSession,
  target: EventTarget | null
): boolean {
  return (
    session.view.contains(target) ||
    (target instanceof Node && (session.pane.terminal.element?.contains(target) ?? false))
  )
}

export function isCopyModeModalOpen(): boolean {
  return useAppStore.getState().activeModal !== 'none'
}

export function createTerminalCopyModeSessions({
  scope,
  platform,
  managerRef
}: {
  scope: HTMLElement
  platform: NodeJS.Platform
  managerRef: React.RefObject<PaneManager | null>
}) {
  let session: TerminalCopyModeSession | null = null
  let stopped = false
  let focusFrame: number | null = null
  const currentPane = (): ManagedPane | null => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    return pane &&
      pane.terminal.element?.isConnected &&
      pane.container.isConnected &&
      !paneIsCoveredByNativeChat(pane)
      ? pane
      : null
  }
  const sessionIsCurrent = (current: TerminalCopyModeSession): boolean =>
    currentPane()?.terminal === current.pane.terminal
  const enterablePane = (): ManagedPane | null => {
    const pane = currentPane()
    return !stopped && pane && !hasPendingTerminalImeComposition(pane.terminal.element)
      ? pane
      : null
  }
  const end = (restoreFocus = false): void => {
    mutations.disconnect()
    if (focusFrame !== null) {
      cancelAnimationFrame(focusFrame)
      focusFrame = null
    }
    const previous = session
    session = null
    if (!previous) {
      return
    }
    previous.view.dispose()
    if (restoreFocus && !stopped && sessionIsCurrent(previous) && !isCopyModeModalOpen()) {
      markTerminalFollowOutput(previous.pane.terminal)
      previous.pane.terminal.scrollToBottom()
      previous.pane.terminal.focus()
    }
  }
  const validate = (): void => {
    if (session && !sessionIsCurrent(session)) {
      end()
    }
  }
  const mutations = new MutationObserver(validate)
  scope.addEventListener('focusin', validate)
  const enter = (): boolean => {
    const pane = enterablePane()
    if (!pane) {
      return false
    }
    if (session?.pane.terminal === pane.terminal) {
      return true
    }
    end()
    try {
      const view = createTerminalCopyModeView(
        pane,
        useAppStore.getState().keybindingSnapshot?.copyMode ?? DEFAULT_TERMINAL_COPY_MODE_CONFIG,
        platform,
        () => end(true),
        () => !stopped && session?.pane.terminal === pane.terminal && !isCopyModeModalOpen(),
        managerRef.current?.hasWebglRenderer(pane.id) ?? false
      )
      session = { pane, view }
      mutations.observe(scope, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      })
      // The palette closes before running an action, but its focus trap settles next frame.
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null
        if (session?.view === view && !isCopyModeModalOpen()) {
          view.focus()
        }
      })
      return true
    } catch {
      end()
      toast.error(
        translate('terminal.copyMode.openFailed', 'Could not open terminal copy mode. Try again.')
      )
      return false
    }
  }
  return {
    current: (): TerminalCopyModeSession | null => session,
    available: (): boolean => enterablePane() !== null,
    enter,
    validate,
    ownedMenuView: (): TerminalCopyModeView | null => {
      if (!session || isCopyModeModalOpen() || !sessionIsCurrent(session)) {
        return null
      }
      return copyModeSessionOwns(session, document.activeElement) ? session.view : null
    },
    dispose(): void {
      stopped = true
      scope.removeEventListener('focusin', validate)
      end()
    }
  }
}

export type TerminalCopyModeSessions = ReturnType<typeof createTerminalCopyModeSessions>
