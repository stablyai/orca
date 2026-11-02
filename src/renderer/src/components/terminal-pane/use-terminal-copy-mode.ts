import { useEffect } from 'react'
import { toast } from 'sonner'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  KEYBINDING_DEFINITIONS,
  keybindingMatchesAction,
  type KeybindingActionId
} from '../../../../shared/keybindings'
import { normalizeTerminalCopyModeConfig } from '../../../../shared/terminal-copy-mode-config'
import { paneIsCoveredByNativeChat } from './native-chat-covered-pane'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'
import { createTerminalCopyModeView, type TerminalCopyModeView } from './terminal-copy-mode-view'
import { registerTerminalCopyModeTarget } from './terminal-copy-mode-targets'
import { installCopyModeMenuGuard } from './terminal-copy-mode-menu'
import {
  claimCopyModeKey,
  consumeCopyModeEvent,
  installCopyModeKeyGuard
} from './terminal-copy-mode-key-guard'
import { markTerminalFollowOutput } from '@/lib/pane-manager/terminal-scroll-intent'

const TERMINAL_SELECTION_ACTIONS = [
  { id: 'terminal.selectAll', action: 'select-all' },
  { id: 'terminal.copySelection', action: 'copy' }
] as const

const PANE_NAVIGATION_ACTIONS = new Set<KeybindingActionId>([
  'terminal.focusNextPane',
  'terminal.focusPreviousPane',
  'terminal.equalizePaneSizes',
  'terminal.expandPane',
  'terminal.closePane',
  'terminal.splitRight',
  'terminal.splitDown'
])
const APP_NAVIGATION_ACTIONS = KEYBINDING_DEFINITIONS.filter(
  (definition) =>
    definition.scope === 'tabs' ||
    (definition.scope === 'global' && definition.id !== 'voice.dictation') ||
    PANE_NAVIGATION_ACTIONS.has(definition.id)
)

export function useTerminalCopyMode({
  tabId,
  isActive,
  isVisible,
  managerRef,
  containerRef
}: {
  tabId: string
  isActive: boolean
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLElement | null>
}): void {
  useEffect(() => {
    if (!isActive || !isVisible) {
      return
    }
    const scope = containerRef.current
    if (!scope) {
      return
    }
    const platform = navigator.userAgent.includes('Mac')
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    let session: { pane: ManagedPane; view: TerminalCopyModeView } | null = null
    let stopped = false
    let focusFrame: number | null = null
    const modalOpen = (): boolean => useAppStore.getState().activeModal !== 'none'
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
    const available = (): boolean => {
      const pane = currentPane()
      return !stopped && pane !== null && !hasPendingTerminalImeComposition(pane.terminal.element)
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
      if (
        restoreFocus &&
        !stopped &&
        currentPane()?.terminal === previous.pane.terminal &&
        !modalOpen()
      ) {
        markTerminalFollowOutput(previous.pane.terminal)
        previous.pane.terminal.scrollToBottom()
        previous.pane.terminal.focus()
      }
    }
    const enter = (): boolean => {
      if (!available()) {
        return false
      }
      const pane = currentPane()
      if (!pane) {
        return false
      }
      if (session?.pane.terminal === pane.terminal) {
        return true
      }
      end()
      try {
        const config = normalizeTerminalCopyModeConfig(
          useAppStore.getState().keybindingSnapshot?.copyMode,
          platform
        )
        const view = createTerminalCopyModeView(
          pane,
          config,
          platform,
          () => end(true),
          () => !stopped && session?.pane.terminal === pane.terminal && !modalOpen(),
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
          if (session?.view === view && !modalOpen()) {
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
    const releaseKeyGuard = installCopyModeKeyGuard()
    const unregister = registerTerminalCopyModeTarget(tabId, { available, enter })
    const releaseMenuGuard = installCopyModeMenuGuard(() => {
      if (!session || modalOpen() || currentPane()?.terminal !== session.pane.terminal) {
        return null
      }
      const target = document.activeElement
      return session.view.contains(target) || session.pane.terminal.element?.contains(target)
        ? session.view
        : null
    })
    const inScope = (target: EventTarget | null): boolean =>
      target instanceof Node && scope.contains(target)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || modalOpen() || !inScope(event.target)) {
        return
      }
      if (session && currentPane()?.terminal !== session.pane.terminal) {
        end()
      }
      const state = useAppStore.getState()
      const options = {
        context: 'terminal' as const,
        terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
      }
      if (!session) {
        if (
          event.isComposing ||
          !keybindingMatchesAction(
            'terminal.enterCopyMode',
            event,
            platform,
            state.keybindings,
            options
          )
        ) {
          return
        }
        if (!event.repeat && enter()) {
          claimCopyModeKey(event, () => false)
          consumeCopyModeEvent(event)
        }
        return
      }
      const owner = session
      if (!owner.view.contains(event.target)) {
        if (
          !(event.target instanceof Node) ||
          !owner.pane.terminal.element?.contains(event.target)
        ) {
          return
        }
        owner.view.focus()
      }
      if (event.isComposing || owner.view.handleKeyDown(event)) {
        claimCopyModeKey(event, () => session === owner)
        consumeCopyModeEvent(event)
        return
      }
      const selectionAction = TERMINAL_SELECTION_ACTIONS.find(({ id }) =>
        keybindingMatchesAction(id, event, platform, state.keybindings, options)
      )
      if (selectionAction) {
        claimCopyModeKey(event, () => session === owner)
        consumeCopyModeEvent(event)
        if (!event.repeat) {
          owner.view.handleMenuSelectionAction(selectionAction.action)
        }
        return
      }
      if (
        APP_NAVIGATION_ACTIONS.some((definition) =>
          keybindingMatchesAction(definition.id, event, platform, state.keybindings, options)
        )
      ) {
        return
      }
      claimCopyModeKey(event, () => session === owner)
      consumeCopyModeEvent(event)
    }
    const onInput = (event: Event): void => {
      if (!session || modalOpen()) {
        return
      }
      if (
        session.view.contains(event.target) ||
        (event.target instanceof Node && session.pane.terminal.element?.contains(event.target))
      ) {
        consumeCopyModeEvent(event)
      }
    }
    const validate = (): void => {
      if (session && currentPane()?.terminal !== session.pane.terminal) {
        end()
      }
    }
    const mutations = new MutationObserver(validate)
    const inputEvents = [
      'beforeinput',
      'input',
      'paste',
      'drop',
      'compositionstart',
      'compositionupdate',
      'compositionend'
    ]
    window.addEventListener('keydown', onKeyDown, true)
    for (const type of inputEvents) {
      window.addEventListener(type, onInput, true)
    }
    scope.addEventListener('focusin', validate)
    return () => {
      stopped = true
      unregister()
      releaseKeyGuard()
      releaseMenuGuard()
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame)
      }
      end()
      window.removeEventListener('keydown', onKeyDown, true)
      for (const type of inputEvents) {
        window.removeEventListener(type, onInput, true)
      }
      scope.removeEventListener('focusin', validate)
    }
  }, [tabId, isActive, isVisible, managerRef, containerRef])
}
