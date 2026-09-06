import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isTerminalPaneCloseChord } from '@/components/terminal-pane/terminal-shortcut-policy'
import { ensureClientCreationActionAllowed } from '@/lib/client-creation-action-error'
import {
  matchFloatingWorkspacePanelOwnedAction,
  matchFloatingWorkspacePanelShortcut
} from '@/lib/floating-workspace-shortcut-policy'
import { isFloatingWorkspaceTerminalInputTarget } from '@/lib/floating-workspace-terminal-actions'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { requestTerminalTabRename } from '@/components/tab-bar/terminal-tab-rename-request'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { KeybindingContext, KeybindingMatchOptions } from '../../../../shared/keybindings'
import type {
  FloatingPanelShortcutInput,
  FloatingPanelShortcutResolution,
  FloatingShortcutOutcome
} from './floating-terminal-panel-types'
import type { FloatingTerminalCloseActions } from './use-floating-terminal-close-actions'
import type { FloatingTerminalCreateActions } from './use-floating-terminal-create-actions'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelMaximize } from './use-floating-terminal-panel-maximize'

const FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'

type FloatingTerminalPanelShortcutsInput = Pick<
  FloatingTerminalPanelItems,
  'activeTab' | 'activeTerminalId' | 'activeClosableTab' | 'visibleFloatingTabOrder'
> &
  Pick<FloatingTerminalPanelLocalState, 'terminalPaneRegistry' | 'panelRef'> &
  Pick<FloatingTerminalCloseActions, 'closeFloatingItemConfirmed'> &
  FloatingTerminalCreateActions &
  FloatingTerminalPanelMaximize & {
    open: boolean
    onOpenChange: (open: boolean) => void
  }

export function useFloatingTerminalPanelShortcuts({
  activeTab,
  activeTerminalId,
  activeClosableTab,
  visibleFloatingTabOrder,
  terminalPaneRegistry,
  panelRef,
  closeFloatingItemConfirmed,
  activateFloatingItem,
  createFloatingTerminalTab,
  createFloatingBrowserTab,
  createFloatingMarkdownTab,
  openFloatingMarkdownTab,
  toggleMaximized,
  open,
  onOpenChange
}: FloatingTerminalPanelShortcutsInput) {
  const closeActiveFloatingTerminalPane = useCallback(() => {
    const handle = activeTerminalId ? terminalPaneRegistry.getHandle(activeTerminalId) : null
    if (handle) {
      handle.closeActivePane()
      return
    }
    if (activeClosableTab) {
      closeFloatingItemConfirmed(activeClosableTab.id)
    }
  }, [activeClosableTab, activeTerminalId, closeFloatingItemConfirmed, terminalPaneRegistry])

  const resolveFloatingPanelShortcut = useCallback(
    (input: FloatingPanelShortcutInput): FloatingPanelShortcutResolution | null => {
      const state = useAppStore.getState()
      const platform = getShortcutPlatform()
      const terminalShortcutPolicy = state.settings?.terminalShortcutPolicy
      const isFloatingTerminalInput = isFloatingWorkspaceTerminalInputTarget(input.target)
      const context: KeybindingContext = input.doubleTapModifier
        ? 'app'
        : isFloatingTerminalInput
          ? 'terminal'
          : 'app'
      const matchOptions: KeybindingMatchOptions = { context, terminalShortcutPolicy }
      const floatingChromeMatchOptions: KeybindingMatchOptions =
        isFloatingTerminalInput && terminalShortcutPolicy === 'terminal-first'
          ? { context: 'app', terminalShortcutPolicy }
          : matchOptions
      const ownedAction = matchFloatingWorkspacePanelOwnedAction(
        input,
        platform,
        state.keybindings,
        matchOptions
      )
      if (ownedAction !== null && ownedAction !== 'tab.close') {
        return { kind: 'create', action: ownedAction }
      }
      const focusedFloatingTerminal =
        isFloatingTerminalInput && activeTab?.contentType === 'terminal'
      if (
        ownedAction === 'tab.close' ||
        (focusedFloatingTerminal &&
          isTerminalPaneCloseChord(input, platform, state.keybindings, matchOptions, matchOptions))
      ) {
        return { kind: 'close', focusedFloatingTerminal }
      }
      const panelShortcut = matchFloatingWorkspacePanelShortcut(
        input,
        platform,
        state.keybindings,
        matchOptions,
        floatingChromeMatchOptions
      )
      if (panelShortcut === null) {
        return null
      }
      return panelShortcut.kind === 'index'
        ? { kind: 'index', index: panelShortcut.index }
        : { kind: 'chrome', action: panelShortcut.action }
    },
    [activeTab]
  )

  const applyFloatingPanelShortcut = useCallback(
    (
      resolution: FloatingPanelShortcutResolution,
      input: FloatingPanelShortcutInput,
      consume: () => void
    ): FloatingShortcutOutcome => {
      if (resolution.kind === 'create') {
        consume()
        if (resolution.action === 'tab.newTerminal') {
          createFloatingTerminalTab()
        } else if (resolution.action === 'tab.newBrowser') {
          if (
            !ensureClientCreationActionAllowed(FLOATING_TERMINAL_WORKTREE_ID, 'managed-browser')
          ) {
            return 'handled'
          }
          createFloatingBrowserTab()
        } else if (resolution.action === 'tab.newMarkdown') {
          createFloatingMarkdownTab()
        } else {
          openFloatingMarkdownTab()
        }
        return 'handled'
      }
      if (resolution.kind === 'close') {
        if (resolution.focusedFloatingTerminal) {
          if (input.doubleTapModifier) {
            consume()
            closeActiveFloatingTerminalPane()
            return 'handled'
          }
          return 'deferred'
        }
        consume()
        if (activeClosableTab) {
          closeFloatingItemConfirmed(activeClosableTab.id)
        } else {
          onOpenChange(false)
        }
        return 'handled'
      }
      if (resolution.kind === 'index') {
        consume()
        const visibleId = visibleFloatingTabOrder[resolution.index]
        if (visibleId) {
          activateFloatingItem(visibleId)
        }
        return 'handled'
      }
      if (resolution.action === 'tab.rename') {
        if (!activeTab) {
          return 'unmatched'
        }
        consume()
        requestTerminalTabRename(activeTab.id)
        return 'handled'
      }
      consume()
      if (resolution.action === 'floatingWorkspace.maximize') {
        toggleMaximized()
      } else {
        onOpenChange(false)
      }
      return 'handled'
    },
    [
      activeClosableTab,
      activeTab,
      activateFloatingItem,
      closeActiveFloatingTerminalPane,
      closeFloatingItemConfirmed,
      createFloatingBrowserTab,
      createFloatingMarkdownTab,
      createFloatingTerminalTab,
      onOpenChange,
      openFloatingMarkdownTab,
      toggleMaximized,
      visibleFloatingTabOrder
    ]
  )

  const handleFloatingPanelShortcutAction = useCallback(
    (input: FloatingPanelShortcutInput, consume: () => void): FloatingShortcutOutcome => {
      const resolution = resolveFloatingPanelShortcut(input)
      return resolution === null
        ? 'unmatched'
        : applyFloatingPanelShortcut(resolution, input, consume)
    },
    [applyFloatingPanelShortcut, resolveFloatingPanelShortcut]
  )

  const floatingShortcutListenersRef = useRef({
    activateFloatingItem,
    closeFloatingItemConfirmed,
    handleFloatingPanelShortcutAction,
    visibleFloatingTabOrder
  })
  useEffect(() => {
    floatingShortcutListenersRef.current = {
      activateFloatingItem,
      closeFloatingItemConfirmed,
      handleFloatingPanelShortcutAction,
      visibleFloatingTabOrder
    }
  }, [
    activateFloatingItem,
    closeFloatingItemConfirmed,
    handleFloatingPanelShortcutAction,
    visibleFloatingTabOrder
  ])

  const handleShortcutSurfaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!open || event.defaultPrevented || event.repeat) {
        return
      }
      const target = event.target
      if (
        !(target instanceof HTMLElement) ||
        (target !== panelRef.current &&
          target.closest(FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR) === null)
      ) {
        return
      }
      const nativeEvent = event.nativeEvent
      const resolution = resolveFloatingPanelShortcut(nativeEvent)
      if (resolution === null) {
        return
      }
      applyFloatingPanelShortcut(resolution, nativeEvent, () => event.preventDefault())
    },
    [applyFloatingPanelShortcut, open, panelRef, resolveFloatingPanelShortcut]
  )

  return { floatingShortcutListenersRef, handleShortcutSurfaceKeyDown }
}

export type FloatingTerminalPanelShortcuts = ReturnType<typeof useFloatingTerminalPanelShortcuts>
