import type { IDisposable } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import type { PaneCwdMap } from '../../layout/split/resolve-split-cwd'
import type { MacOptionAsAlt } from './terminal-option-shortcut-policy'
import type {
  KeybindingOverrides,
  KeybindingPlatform,
  TerminalShortcutPolicy
} from '../../../../../../shared/keybindings/types'
import type { TerminalKittyKeyboardModeTracker } from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { getLayoutCharacterForCode } from '@/lib/keyboard-layout/layout-base-character'
import { createOptionKeyLocationTracker } from '@/lib/keyboard-layout/option-key-location-state'
import { createTerminalOptionKittyReleaseTracker } from './terminal-option-kitty-release'
import {
  createTerminalImeDeferredNewlineSender,
  createTerminalImeModifiedEnterChordOwner,
  getTerminalImeModifiedEnterKind
} from '../ime/terminal-ime-deferred-newline'
import { createTerminalImeDeferredChordSender } from '../ime/terminal-ime-deferred-chord'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import { hasCtrlEnterCsiUAuthorityForPane } from './terminal-ctrl-enter'
import { titleHasExplicitAgentIdentity } from '../../titles/title-agent-identity'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTerminalInputHostPlatform } from '../terminal-input-host-platform'
import { isTerminalPaneLocalWindowsConpty } from '../../host-state/terminal-pane-local-windows-conpty'
import { readLocalWindowsCmdPromptPane } from './terminal-local-windows-cmd-conpty'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'
import { isEditableTarget } from './terminal-keyboard-shortcut-matching'
import { resolveTerminalShortcutAction as resolveTerminalKeyboardShortcutAction } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'
import { createTerminalKeyboardInputSender } from './terminal-keyboard-captured-input'

type RuntimeOptions = {
  tabId: string
  worktreeId: string
  isMac: boolean
  isWindows: boolean
  shortcutPlatform: KeybindingPlatform
  keyboardScopeRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  fallbackCwd: string
  macOptionAsAltRef: React.RefObject<MacOptionAsAlt>
  paneKittyKeyboardModesRef?: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  keybindings?: KeybindingOverrides
  terminalShortcutPolicy: TerminalShortcutPolicy
}

export function createTerminalKeyboardRuntime(options: RuntimeOptions) {
  const {
    tabId,
    worktreeId,
    isMac,
    isWindows,
    shortcutPlatform,
    keyboardScopeRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy
  } = options
  const optionKeyLocations = createOptionKeyLocationTracker()
  const optionKittyReleases = createTerminalOptionKittyReleaseTracker()
  const heldImeEnterModifiers = new Set<'shift' | 'ctrl'>()
  const terminalImeEnterModifierKeydowns = new Set<'shift' | 'ctrl'>()
  const nativeOnlyShortcutTracker = createTerminalNativeOnlyShortcutTracker()
  const deferredNewlineSender = createTerminalImeDeferredNewlineSender()
  const deferredChordSender = createTerminalImeDeferredChordSender()
  const modifiedEnterChordOwner = createTerminalImeModifiedEnterChordOwner()
  const observedEnterKeydownTimeStamps = new Map<string, number[]>()

  const reconcileHeldImeEnterModifiers = (event: KeyboardEvent, preserve = false): void => {
    for (const [kind, pressed] of [
      ['shift', event.getModifierState('Shift')],
      ['ctrl', event.getModifierState('Control')]
    ] as const) {
      const belongs =
        preserve &&
        modifiedEnterChordOwner.absorb({ kind, code: event.code, timeStamp: event.timeStamp })
      if (!pressed && !belongs && heldImeEnterModifiers.delete(kind)) {
        modifiedEnterChordOwner.release({ kind, code: event.code, timeStamp: event.timeStamp })
      }
    }
  }
  const getHeldImeEnterModifier = () =>
    heldImeEnterModifiers.size === 1 ? (heldImeEnterModifiers.values().next().value ?? null) : null
  const getImeEnterModifier = (event: KeyboardEvent) => {
    const kind = getTerminalImeModifiedEnterKind(event)
    if (kind || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return kind
    }
    return getHeldImeEnterModifier()
  }
  const getModifiedEnterChord = (event: KeyboardEvent) => {
    const kind = getImeEnterModifier(event)
    return kind ? { kind, code: event.code, timeStamp: event.timeStamp } : null
  }
  const onModifierDown = (event: KeyboardEvent): void => {
    reconcileHeldImeEnterModifiers(event, event.key === 'Enter' && event.keyCode === 13)
    optionKeyLocations.keyDown(event)
    if (isWindows && (event.key === 'Shift' || event.key === 'Control')) {
      const manager = managerRef.current
      const scope = keyboardScopeRef.current
      const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (
        pane &&
        (!scope || keyboardEventBelongsToScope(event, scope)) &&
        !isEditableTarget(event.target)
      ) {
        const kind = event.key === 'Shift' ? 'shift' : 'ctrl'
        heldImeEnterModifiers.add(kind)
        terminalImeEnterModifierKeydowns.add(kind)
      }
    }
  }
  const isLocalWindowsConptyForPane = (pane: { id: number } | undefined): boolean => {
    if (!pane) {
      return false
    }
    return isTerminalPaneLocalWindowsConpty({
      isWindows,
      userAgent: navigator.userAgent,
      state: useAppStore.getState(),
      worktreeId,
      tabId,
      paneId: pane.id,
      paneCwd: paneCwdRef.current,
      fallbackCwd,
      transport: paneTransportsRef.current.get(pane.id) ?? null
    })
  }
  const isLocalWindowsConptyPane = (): boolean =>
    isLocalWindowsConptyForPane(
      managerRef.current?.getActivePane() ?? managerRef.current?.getPanes()[0]
    )
  const getActivePaneWindowsShiftEnterEncoding = () => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (!pane) {
      return 'alt-enter' as const
    }
    const state = useAppStore.getState()
    const paneKey = makePaneKey(tabId, pane.leafId)
    return resolveWindowsShiftEnterEncodingForPane(
      state,
      paneKey,
      isLocalWindowsConptyPane() ? state.runtimePaneTitlesByTabId[tabId]?.[pane.id] : undefined
    )
  }
  const isActivePaneWindowsTerminalHost = (): boolean => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    return (
      resolveTerminalInputHostPlatform({
        clientPlatform: shortcutPlatform,
        state: useAppStore.getState(),
        worktreeId,
        transport: pane ? (paneTransportsRef.current.get(pane.id) ?? null) : null
      }) === 'win32'
    )
  }
  const getKittyKeyboardFlagsActivePane = (): number => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    return pane ? (paneKittyKeyboardModesRef?.current.get(pane.id)?.flags ?? 0) : 0
  }
  const getModifyOtherKeysActivePane = (): number => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    return pane ? (paneKittyKeyboardModesRef?.current.get(pane.id)?.modifyOtherKeys ?? 0) : 0
  }
  const hasActivePaneCtrlEnterCsiUAuthority = (): boolean => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (!pane) {
      return false
    }
    const state = useAppStore.getState()
    return hasCtrlEnterCsiUAuthorityForPane(
      state,
      makePaneKey(tabId, pane.leafId),
      isLocalWindowsConptyPane() ? state.runtimePaneTitlesByTabId[tabId]?.[pane.id] : undefined
    )
  }
  const isActivePaneNonAgentFullScreen = (): boolean => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (pane?.terminal.buffer.active.type !== 'alternate') {
      return false
    }
    const state = useAppStore.getState()
    const paneKey = makePaneKey(tabId, pane.leafId)
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    if (foreground?.agent && !foreground.shellForeground) {
      return false
    }
    const hookRow = state.agentStatusByPaneKey[paneKey]
    if (hookRow && hookRow.state !== 'done') {
      return false
    }
    if (isTuiAgent(state.agentLaunchConfigByPaneKey[paneKey]?.identity?.agentType)) {
      return false
    }
    return !titleHasExplicitAgentIdentity(state.runtimePaneTitlesByTabId[tabId]?.[pane.id] ?? '')
  }
  const isPaneLocalCmdPrompt = (pane: { id: number; leafId: string } | undefined): boolean => {
    return readLocalWindowsCmdPromptPane({
      isWindows,
      tabId,
      pane,
      transport: pane && paneTransportsRef.current.get(pane.id),
      isLocalWindowsConpty: () => isLocalWindowsConptyForPane(pane)
    })
  }
  const resolveShortcutEvent = (
    event: Parameters<typeof resolveTerminalKeyboardShortcutAction>[0]
  ) =>
    resolveTerminalKeyboardShortcutAction(
      event,
      isMac,
      macOptionAsAltRef.current,
      optionKeyLocations.get(),
      isWindows,
      keybindings,
      isLocalWindowsConptyPane,
      getKittyKeyboardFlagsActivePane,
      getLayoutCharacterForCode,
      getActivePaneWindowsShiftEnterEncoding,
      isActivePaneWindowsTerminalHost,
      terminalShortcutPolicy,
      hasActivePaneCtrlEnterCsiUAuthority,
      getModifyOtherKeysActivePane,
      isActivePaneNonAgentFullScreen,
      () =>
        isPaneLocalCmdPrompt(
          managerRef.current?.getActivePane() ?? managerRef.current?.getPanes()[0]
        )
    )
  const createCapturedInputSender = createTerminalKeyboardInputSender({
    tabId,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    isLocalCmdPrompt: isPaneLocalCmdPrompt
  })
  return {
    optionKeyLocations,
    optionKittyReleases,
    heldImeEnterModifiers,
    terminalImeEnterModifierKeydowns,
    nativeOnlyShortcutTracker,
    deferredNewlineSender,
    deferredChordSender,
    modifiedEnterChordOwner,
    observedEnterKeydownTimeStamps,
    reconcileHeldImeEnterModifiers,
    getImeEnterModifier,
    getModifiedEnterChord,
    onModifierDown,
    resolveShortcutEvent,
    createCapturedInputSender
  }
}
