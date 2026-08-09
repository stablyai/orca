/* eslint-disable max-lines -- Why: terminal keyboard routing keeps shortcut
 * precedence in one ordered handler so shell input, pane commands, search, and
 * split actions do not race across separate window listeners. */
import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { safeFind } from '../terminal-search-safe-find'
import { isImeExemptTerminalChord, resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'
import {
  createTerminalImeDeferredNewlineSender,
  createTerminalImeModifiedEnterChordOwner,
  getTerminalImeModifiedEnterKind,
  isTerminalImeConsumedKey,
  isTerminalImeEnterKeyUp,
  isTerminalImeProcessEnter
} from './terminal-ime-deferred-newline'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import {
  requestCapturedTerminalReconfirmation,
  sendCapturedTerminalInput
} from './terminal-captured-input-dispatch'
import {
  keybindingMatchesAction,
  type KeybindingOverrides,
  type KeybindingPlatform,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { keyboardEventBelongsToScope } from './terminal-keyboard-scope'
import {
  getLayoutBaseCharacterForCode,
  prefetchLayoutBaseCharacters
} from '@/lib/keyboard-layout/layout-base-character'
import { normalizeSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { isFindQueryTooLarge } from '@/lib/find-query-bounds'
import { handleEmptyFloatingWorkspacePanelCloseShortcut } from '@/lib/floating-workspace-terminal-actions'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { useAppStore } from '@/store'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { copyTerminalSelection } from './terminal-selection-copy'
import { isLocalWindowsConptyPaneForCtrlArrow } from './terminal-ctrl-arrow-conpty'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import { hasCtrlEnterCsiUAuthorityForPane } from './terminal-ctrl-enter'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'

// What runShortcutAction actually touches. Narrow so the release can hand it a chord that
// answers for the press rather than for the event that happens to be in flight.
type ShortcutActionEvent = {
  key: string
  code?: string
  repeat: boolean
  preventDefault: () => void
  stopImmediatePropagation: () => void
}

type PendingImeChord = Parameters<typeof resolveTerminalShortcutAction>[0] &
  Required<Pick<Parameters<typeof resolveTerminalShortcutAction>[0], 'code' | 'repeat'>> & {
    isComposing: boolean
  }

/**
 * A chord the IME took on keydown, kept until the key comes up so the release can answer for
 * the press rather than for whatever the keyboard looks like by then.
 *
 * Recorded on stock macOS, and the two input sources answer in opposite ways. Both marked
 * keydowns are identical (`code='ArrowLeft'`, `keyCode=229`, `isComposing=true`), so nothing
 * can be decided when the key goes down. By the time it comes up they have separated:
 *
 *   - Korean 2-Set committed the syllable and ended the composition, then the platform
 *     replays the chord unmarked. `isComposing` is false at release, and that replay resolves
 *     on its own — acting there too would send it twice, which for `Option+←` is two words.
 *   - Japanese conversion swallowed the chord whole: no commit, no replay, and the
 *     composition is still live at release. Nothing else will ever deliver it.
 *
 * So a still-composing release means the chord has no other route to the shell. xterm queues
 * the bytes behind the preedit and flushes them on commit, so sending them cannot reorder them
 * ahead of the text being composed.
 *
 * The snapshot is what makes reading the release safe. A `KeyboardEvent`'s modifier flags
 * describe the moment it fired, and releasing `Cmd` before `←` leaves the arrow's keyup with
 * `metaKey: false` — matching on that loses the chord entirely.
 *
 * TODO: one release is one action, so holding a swallowed chord down repeats nothing. Acting
 * on the auto-repeat instead would have to run before the two cases separate, so this waits
 * for a trace showing a user holds a chord mid-preedit.
 */
function imeChordSnapshot(event: KeyboardEvent): PendingImeChord {
  // Field by field, and it must stay that way: a browser keeps KeyboardEvent's fields as
  // prototype accessors, so `{ ...event }` is an empty object and the snapshot loses its
  // `code`, which silently disables the whole recovery. happy-dom keeps them as own properties
  // and would go on passing, so this is the only warning that survives in the source.
  return {
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    // One release is one action, so the auto-repeat presses behind it are not repeats of it.
    repeat: false,
    // `isComposing` alone marks this as IME-owned for every consumer; the keyCode that also
    // marked the press adds nothing once the press is over.
    isComposing: true
  }
}

/**
 * Which release answers for a pending chord. Normally the chord's own key, but a key released
 * while `Cmd` is held has no keyup at all: recorded in-app at Chromium's own input dispatch,
 * `Cmd+←` delivers a keydown and nothing after it, while `Option+←` and a bare `←` both deliver
 * their keyup there. Nothing in the app consumes it — it never arrives. The `Cmd` release does,
 * still marked as composing, and it ends the same gesture.
 *
 * Korean cannot double-fire through this. It commits on the chord, so its own keyup arrives
 * first and spends the carry, and both releases report the composition already over.
 */
function releasesPendingImeChord(chord: PendingImeChord, event: KeyboardEvent): boolean {
  return chord.code === event.code || (chord.metaKey === true && event.key === 'Meta')
}

/**
 * No IME gate here on purpose: the pane calls this for a swallowed chord's RELEASE, where the
 * event still reports itself as composing and resolving it is the whole point. Which composing
 * events reach a resolver at all is the pane's decision, not this function's — so a keydown
 * outcome asserted against this function alone pins something the pane does not do.
 */
export function resolveTerminalKeyboardShortcutAction(
  event: Parameters<typeof resolveTerminalShortcutAction>[0],
  isMac: Parameters<typeof resolveTerminalShortcutAction>[1],
  macOptionAsAlt: Parameters<typeof resolveTerminalShortcutAction>[2],
  optionKeyLocation: Parameters<typeof resolveTerminalShortcutAction>[3],
  isWindows: Parameters<typeof resolveTerminalShortcutAction>[4],
  keybindings: Parameters<typeof resolveTerminalShortcutAction>[5],
  isLocalWindowsConptyPane: Parameters<typeof resolveTerminalShortcutAction>[6],
  isKittyKeyboardActivePane: Parameters<typeof resolveTerminalShortcutAction>[7],
  layoutBaseCharacterForCode: Parameters<typeof resolveTerminalShortcutAction>[8],
  getWindowsShiftEnterEncoding: Parameters<typeof resolveTerminalShortcutAction>[9],
  isWindowsTerminalHost: NonNullable<Parameters<typeof resolveTerminalShortcutAction>[10]>,
  terminalShortcutPolicy: Parameters<typeof resolveTerminalShortcutAction>[11] = 'orca-first',
  hasCtrlEnterCsiUAuthority?: Parameters<typeof resolveTerminalShortcutAction>[12]
): ReturnType<typeof resolveTerminalShortcutAction> {
  // Why: keep the host callback required at the production boundary so a
  // caller cannot silently fall back to client-OS byte routing.
  return resolveTerminalShortcutAction(
    event,
    isMac,
    macOptionAsAlt,
    optionKeyLocation,
    isWindows,
    keybindings,
    isLocalWindowsConptyPane,
    isKittyKeyboardActivePane,
    layoutBaseCharacterForCode,
    getWindowsShiftEnterEncoding,
    isWindowsTerminalHost,
    terminalShortcutPolicy,
    hasCtrlEnterCsiUAuthority
  )
}

export function recordKeyboardCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: 'contextual_tour' | 'keyboard'
    direction: 'vertical' | 'horizontal'
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

// Bounds evidence when Chromium drops a matching keyup.
const MAX_OBSERVED_ENTER_KEYDOWNS_PER_CODE = 8

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
  // keyboard input.  That element IS an editable target, but we must NOT
  // suppress terminal shortcuts when the terminal itself is focused.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editableAncestor = target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  )
  return editableAncestor !== null
}

export type SearchState = {
  query: string
  caseSensitive: boolean
  regex: boolean
}

export type SearchNavigationDirection = 'next' | 'previous'

/**
 * Pure decision function for Cmd+G / Cmd+Shift+G search navigation.
 * Returns 'next', 'previous', or null (no match).
 * Extracted so the key-matching logic is testable without DOM dependencies.
 */
export function matchSearchNavigate(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
  searchOpen: boolean,
  searchState: SearchState
): SearchNavigationDirection | null {
  if (e.altKey) {
    return null
  }
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) {
    return null
  }
  if (e.key.toLowerCase() !== 'g') {
    return null
  }
  if (!searchOpen) {
    return null
  }
  if (!searchState.query) {
    return null
  }
  if (isFindQueryTooLarge(searchState.query)) {
    return null
  }
  return e.shiftKey ? 'previous' : 'next'
}

export function runTerminalSearchNavigation(
  pane: Pick<ManagedPane, 'searchAddon'>,
  direction: SearchNavigationDirection,
  searchState: SearchState
): boolean {
  const { query, caseSensitive, regex } = searchState
  const options = { caseSensitive, regex }

  // Why: Cmd/Ctrl+G hits the same xterm decoration path as the search panel,
  // so narrow-viewport highlight failures need the same containment.
  return direction === 'next'
    ? safeFind((term, findOptions) => pane.searchAddon.findNext(term, findOptions), query, options)
    : safeFind(
        (term, findOptions) => pane.searchAddon.findPrevious(term, findOptions),
        query,
        options
      )
}

export function matchFileSearchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'>,
  platform: KeybindingPlatform,
  keybindings?: KeybindingOverrides,
  terminalShortcutPolicy: TerminalShortcutPolicy = 'orca-first'
): boolean {
  if (e.repeat) {
    return false
  }
  return keybindingMatchesAction('sidebar.search.toggle', e, platform, keybindings, {
    context: 'terminal',
    terminalShortcutPolicy
  })
}

type KeyboardHandlersDeps = {
  tabId: string
  worktreeId: string
  isActive: boolean
  keyboardScopeRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  /** Worktree-root cwd used when OSC 7 and pty.getCwd both fail. */
  fallbackCwd: string
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onSearchSelectedText: (text: string) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  searchOpenRef: React.RefObject<boolean>
  searchStateRef: React.RefObject<SearchState>
  macOptionAsAltRef: React.RefObject<MacOptionAsAlt>
  paneKittyKeyboardModesRef?: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  keybindings?: KeybindingOverrides
  terminalShortcutPolicy?: TerminalShortcutPolicy
}

/**
 * Installs terminal-pane shortcuts on the tab keyboard scope.
 * Uses the shared shortcut policy before forwarding unmatched input to xterm
 * so configurable Orca actions remain consistent across local and SSH panes.
 */
export function useTerminalKeyboardShortcuts({
  tabId,
  worktreeId,
  isActive,
  keyboardScopeRef,
  managerRef,
  paneTransportsRef,
  panePtyBindingsRef,
  paneCwdRef,
  fallbackCwd,
  expandedPaneIdRef,
  setExpandedPane,
  restoreExpandedLayout,
  refreshPaneSizes,
  persistLayoutSnapshot,
  toggleExpandPane,
  setSearchOpen,
  onSearchSelectedText,
  onRequestClosePane,
  onClearPaneScrollback,
  onSetTitle,
  onClearPaneTitle,
  searchOpenRef,
  searchStateRef,
  macOptionAsAltRef,
  paneKittyKeyboardModesRef,
  keybindings,
  terminalShortcutPolicy = 'orca-first'
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const isWindows = navigator.userAgent.includes('Windows')
    const shortcutPlatform: KeybindingPlatform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'

    // Why: kitty Option-chord encoding resolves base keys through the async
    // KeyboardLayoutMap; prefetch so the map is cached before the first chord.
    if (isMac) {
      prefetchLayoutBaseCharacters()
    }

    // Why: KeyboardEvent.location on a character key (e.g. Period) always
    // reports that key's own position (0 = standard), not which modifier is
    // held. To distinguish left vs right Option, we record the Option key's
    // location from its own keydown event and clear it on keyup.
    let optionKeyLocation = 0
    const heldImeEnterModifiers = new Set<'shift' | 'ctrl'>()
    const terminalImeEnterModifierKeydowns = new Set<'shift' | 'ctrl'>()
    let pendingImeChord: PendingImeChord | null = null
    const nativeOnlyShortcutTracker = createTerminalNativeOnlyShortcutTracker()
    const deferredNewlineSender = createTerminalImeDeferredNewlineSender()
    const modifiedEnterChordOwner = createTerminalImeModifiedEnterChordOwner()
    const reconcileHeldImeEnterModifiers = (
      event: KeyboardEvent,
      preserveModifierLostRedispatch = false
    ): void => {
      if (heldImeEnterModifiers.size === 0) {
        return
      }
      for (const [kind, pressed] of [
        ['shift', event.getModifierState('Shift')],
        ['ctrl', event.getModifierState('Control')]
      ] as const) {
        const belongsToActiveChord =
          preserveModifierLostRedispatch &&
          modifiedEnterChordOwner.absorb({ kind, code: event.code, timeStamp: event.timeStamp })
        if (!pressed && !belongsToActiveChord && heldImeEnterModifiers.delete(kind)) {
          modifiedEnterChordOwner.release({ kind, code: event.code, timeStamp: event.timeStamp })
        }
      }
    }
    // Press evidence distinguishes swallowed keydowns from modifier rollover on keyup.
    const observedEnterKeydownTimeStamps = new Map<string, number[]>()
    const getHeldImeEnterModifier = () =>
      heldImeEnterModifiers.size === 1
        ? (heldImeEnterModifiers.values().next().value ?? null)
        : null
    const getImeEnterModifier = (event: KeyboardEvent) => {
      const eventKind = getTerminalImeModifiedEnterKind(event)
      if (eventKind || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        return eventKind
      }
      return getHeldImeEnterModifier()
    }
    const getModifiedEnterChord = (event: KeyboardEvent) => {
      const kind = getImeEnterModifier(event)
      return kind ? { kind, code: event.code, timeStamp: event.timeStamp } : null
    }
    const onModifierDown = (e: KeyboardEvent): void => {
      reconcileHeldImeEnterModifiers(e, e.key === 'Enter' && e.keyCode === 13)
      if (e.key === 'Alt') {
        optionKeyLocation = e.location
      }
      if (isWindows && (e.key === 'Shift' || e.key === 'Control')) {
        const manager = managerRef.current
        const keyboardScope = keyboardScopeRef.current
        const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
        if (
          pane &&
          (!keyboardScope || keyboardEventBelongsToScope(e, keyboardScope)) &&
          !isEditableTarget(e.target)
        ) {
          const kind = e.key === 'Shift' ? 'shift' : 'ctrl'
          heldImeEnterModifiers.add(kind)
          terminalImeEnterModifierKeydowns.add(kind)
        }
      }
    }

    // Why: modified-Enter trust and Ctrl+Arrow translation are local ConPTY-only;
    // resolve lazily so session/runtime lookups stay off ordinary keystrokes.
    const isLocalWindowsConptyPane = (): boolean => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!activePane) {
        return false
      }
      const storeState = useAppStore.getState()
      return isLocalWindowsConptyPaneForCtrlArrow({
        isWindows,
        userAgent: navigator.userAgent,
        state: storeState,
        worktreeId,
        tabId,
        paneId: activePane.id,
        paneCwd: paneCwdRef.current,
        fallbackCwd,
        transport: paneTransportsRef.current.get(activePane.id) ?? null
      })
    }

    // Why: this callback is installed once per active tab and invoked only for
    // Windows Shift+Enter, keeping store work and allocations off ordinary keys.
    const getActivePaneWindowsShiftEnterEncoding = () => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!activePane) {
        return 'alt-enter' as const
      }
      const state = useAppStore.getState()
      const paneKey = makePaneKey(tabId, activePane.leafId)
      return resolveWindowsShiftEnterEncodingForPane(
        state,
        paneKey,
        isLocalWindowsConptyPane()
          ? state.runtimePaneTitlesByTabId[tabId]?.[activePane.id]
          : undefined
      )
    }

    // Why: host metadata is live and can hydrate after the terminal mounts;
    // resolve it only when Shift+Enter needs to choose a byte protocol.
    const isActivePaneWindowsTerminalHost = (): boolean => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      return (
        resolveTerminalInputHostPlatform({
          clientPlatform: shortcutPlatform,
          state: useAppStore.getState(),
          worktreeId,
          transport: activePane ? (paneTransportsRef.current.get(activePane.id) ?? null) : null
        }) === 'win32'
      )
    }

    // Why: the pane's TUI opted into kitty keyboard reporting via CSI > u;
    // the tracker mirrors that from PTY output so the policy can encode
    // Option chords the way the application negotiated.
    const isKittyKeyboardActivePane = (): boolean => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!activePane) {
        return false
      }
      return (paneKittyKeyboardModesRef?.current.get(activePane.id)?.flags ?? 0) > 0
    }

    const hasActivePaneCtrlEnterCsiUAuthority = (): boolean => {
      const manager = managerRef.current
      const activePane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!activePane) {
        return false
      }
      const state = useAppStore.getState()
      return hasCtrlEnterCsiUAuthorityForPane(
        state,
        makePaneKey(tabId, activePane.leafId),
        isLocalWindowsConptyPane()
          ? state.runtimePaneTitlesByTabId[tabId]?.[activePane.id]
          : undefined
      )
    }

    const resolveShortcutEvent = (
      event: Parameters<typeof resolveTerminalKeyboardShortcutAction>[0]
    ): ReturnType<typeof resolveTerminalKeyboardShortcutAction> =>
      resolveTerminalKeyboardShortcutAction(
        event,
        isMac,
        macOptionAsAltRef.current,
        optionKeyLocation,
        isWindows,
        keybindings,
        isLocalWindowsConptyPane,
        isKittyKeyboardActivePane,
        getLayoutBaseCharacterForCode,
        getActivePaneWindowsShiftEnterEncoding,
        isActivePaneWindowsTerminalHost,
        terminalShortcutPolicy,
        hasActivePaneCtrlEnterCsiUAuthority
      )

    const createCapturedInputSender = (
      pane: { id: number; leafId: string },
      data: string
    ): (() => void) => {
      const capturedTransport = paneTransportsRef.current.get(pane.id)
      const capturedPtyId = capturedTransport?.getPtyId() ?? null
      const capturedBinding = panePtyBindingsRef.current.get(pane.id) as
        | (IDisposable & { requestWindowsShiftEnterReconfirmation?: () => void })
        | undefined
      const getCurrentManager = () => managerRef.current
      const getCurrentTransport = () => paneTransportsRef.current.get(pane.id)
      const getCurrentBinding = () => panePtyBindingsRef.current.get(pane.id)
      return () => {
        const targetPaneMounted =
          getCurrentManager()
            ?.getPanes()
            .some((candidate) => candidate.id === pane.id && candidate.leafId === pane.leafId) ===
          true
        const sent = sendCapturedTerminalInput({
          targetPaneMounted,
          currentTransport: getCurrentTransport(),
          capturedTransport,
          capturedPtyId,
          data
        })
        if (sent) {
          recordTerminalUserInputForLeaf(tabId, pane.leafId)
          if (data === '\x1b[13;2u') {
            // Why: this write bypasses PTY onData, so no-OSC shells need reconfirmation.
            requestCapturedTerminalReconfirmation(getCurrentBinding(), capturedBinding)
          }
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Why: replace stale state only for this physical key so rollover cannot
      // disarm a still-held native-only chord before its Kitty keyup arrives.
      nativeOnlyShortcutTracker.prepareKeyDown(e)
      // Record before early returns so every observed Enter disqualifies keyup synthesis.
      if (
        isWindows &&
        ((e.key === 'Enter' && e.keyCode === 13) ||
          (e.keyCode === 229 && (e.code === 'Enter' || e.code === 'NumpadEnter')))
      ) {
        const observed = observedEnterKeydownTimeStamps.get(e.code)
        if (!observed) {
          observedEnterKeydownTimeStamps.set(e.code, [e.timeStamp])
        } else if (!e.repeat && observed.length < MAX_OBSERVED_ENTER_KEYDOWNS_PER_CODE) {
          // Auto-repeat shares one physical release.
          observed.push(e.timeStamp)
        }
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const keyboardScope = keyboardScopeRef.current
      if (keyboardScope && !keyboardEventBelongsToScope(e, keyboardScope)) {
        return
      }
      // Any press of this key ends whatever the last one carried, whoever owns this one. A key
      // pressed outside a composition resolves from here, so a composition starting while it is
      // held must not turn its release into a second firing; and a carry whose release never
      // arrived — focus left the window mid-chord — must not answer for an unrelated later
      // press of the same key. Scoped to this code so rollover leaves other keys alone.
      if (pendingImeChord?.code === e.code) {
        pendingImeChord = null
      }
      // Only the exempt chords yield here: an IME that swallows one leaves no other route to the
      // shell, so it is recovered from the release. Every other IME-owned key keeps the paths
      // below, which own the composing Enter.
      if (isImeOwnedKeyboardEvent(e) && isImeExemptTerminalChord(e)) {
        // Not armed from a rename field or the search input: that field can unmount before the
        // key comes up, and the release would then arrive with the terminal as its target and
        // pass the guard below, sending a chord aimed at the field to the shell.
        if (!isEditableTarget(e.target)) {
          pendingImeChord = imeChordSnapshot(e)
        }
        return
      }

      const modifiedEnterChord = isWindows ? getModifiedEnterChord(e) : null
      if (
        e.key === 'Enter' &&
        e.keyCode === 13 &&
        !e.isComposing &&
        (modifiedEnterChordOwner.ownsRedispatchedEnter() ||
          (modifiedEnterChord && modifiedEnterChordOwner.absorb(modifiedEnterChord)) ||
          deferredNewlineSender.absorbRedispatchedEnter(e))
      ) {
        // Chromium can drop the modifier when re-dispatching the committing Enter.
        reconcileHeldImeEnterModifiers(e)
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }

      const terminalPaneForImeShortcut = manager.getActivePane() ?? manager.getPanes()[0]
      const hasPendingImeComposition = hasPendingTerminalImeComposition(
        terminalPaneForImeShortcut?.terminal.element
      )
      const imeProcessEnter = isWindows && hasPendingImeComposition && isTerminalImeProcessEnter(e)
      if (
        isWindows &&
        hasPendingImeComposition &&
        !imeProcessEnter &&
        isTerminalImeConsumedKey(e)
      ) {
        // Process has no logical key, so shortcut matching would fall back to its physical code.
        e.stopImmediatePropagation()
        return
      }

      if (matchFileSearchShortcut(e, shortcutPlatform, keybindings, terminalShortcutPolicy)) {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        const selectedText = normalizeSelectedTextForFileSearch(pane?.terminal.getSelection())
        if (selectedText) {
          e.preventDefault()
          e.stopImmediatePropagation()
          onSearchSelectedText(selectedText)
          return
        }
      }

      // Cmd+G / Cmd+Shift+G navigates terminal search matches even when focus
      // is inside the search input itself, so this check must run before the
      // editable-target guard would otherwise bypass all terminal shortcuts.
      // stopImmediatePropagation prevents App.tsx's Cmd+Shift+G (source-control sidebar) from also firing.
      const direction = matchSearchNavigate(e, isMac, searchOpenRef.current, searchStateRef.current)
      if (direction !== null) {
        if (e.repeat) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        runTerminalSearchNavigation(pane, direction, searchStateRef.current)
        pane.terminal.focus()
        return
      }

      if (isEditableTarget(e.target)) {
        return
      }

      if (handleEmptyFloatingWorkspacePanelCloseShortcut(e, shortcutPlatform, keybindings)) {
        return
      }

      const shortcutEvent = imeProcessEnter
        ? {
            key: 'Enter',
            code: e.code,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
            repeat: e.repeat
          }
        : e
      const action = resolveShortcutEvent(shortcutEvent)
      if (!action) {
        return
      }
      runShortcutAction(e, action, manager, (pane, sendResolvedInput) => {
        if (!((e.isComposing || hasPendingImeComposition) && (e.key === 'Enter' || imeProcessEnter))) {
          return false
        }
        if (isWindows) {
          const chord = getModifiedEnterChord(e)
          const claimedChord = chord
            ? {
                ...chord,
                terminalModifierKeyDownObserved: terminalImeEnterModifierKeydowns.has(chord.kind)
              }
            : null
          if (claimedChord && !modifiedEnterChordOwner.claim(claimedChord)) {
            return true
          }
        }
        deferredNewlineSender.defer(e, pane.terminal.element, sendResolvedInput)
        return true
      })
    }

    // Shared by the keydown path and the swallowed-chord release below, so a chord recovered
    // from a release runs the same action a press would — including remaps onto pane commands.
    function runShortcutAction(
      e: ShortcutActionEvent,
      action: NonNullable<ReturnType<typeof resolveShortcutEvent>>,
      manager: PaneManager,
      // Why a callback: deferring a composing Enter reads the live keydown and its
      // imeProcessEnter, which a chord recovered from a release has neither of — and never is.
      deferComposingEnter?: (pane: ManagedPane, sendResolvedInput: () => void) => boolean
    ): void {
      if (action.type === 'switchInputSource') {
        // Why: the OS must receive its default action, while xterm must receive
        // none of the keydown, keypress, or keyup sequence.
        nativeOnlyShortcutTracker.armKeyDown(e)
        e.stopImmediatePropagation()
        return
      }

      if (action.type === 'sendInput') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        const sendResolvedInput = createCapturedInputSender(pane, action.data)
        if (deferComposingEnter?.(pane, sendResolvedInput)) {
          return
        }
        sendResolvedInput()
        return
      }

      if (e.repeat) {
        return
      }

      // Cmd/Ctrl+Shift+C copies terminal selection via Electron clipboard.
      // This ensures Linux terminal copy works consistently.
      if (action.type === 'copySelection') {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        if (!pane.terminal.getSelection()) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        void copyTerminalSelection({
          terminal: pane.terminal,
          writeClipboardText: window.api.ui.writeTerminalClipboardText
        }).catch(() => {
          /* ignore clipboard write failures */
        })
        return
      }

      // Keep Cmd+F bound to the terminal search until the app has a real
      // top-level find-in-page flow to fall back to.
      if (action.type === 'toggleSearch') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (action.type === 'clearActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane) {
          onClearPaneScrollback(pane)
        }
        return
      }

      if (action.type === 'scrollViewport') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        if (action.position === 'top') {
          markTerminalPinnedViewport(pane.terminal)
          pane.terminal.scrollToLine(0)
          syncTerminalScrollIntentFromViewport(pane.terminal)
        } else {
          markTerminalFollowOutput(pane.terminal)
          pane.terminal.scrollToBottom()
          syncTerminalScrollIntentFromViewport(pane.terminal)
        }
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (action.type === 'focusPane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()

        // Collapse expanded pane before switching
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }

        const activeId = manager.getActivePane()?.id ?? panes[0].id
        const currentIdx = panes.findIndex((p) => p.id === activeId)
        if (currentIdx === -1) {
          return
        }

        const dir = action.direction === 'next' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        manager.setActivePane(nextPane.id, { focus: true })
        return
      }

      if (action.type === 'equalizePaneSizes') {
        // Consume the chord first so a user-assigned terminal shortcut can't fall
        // through to app-level zoom when an expanded pane blocks the equalize.
        e.preventDefault()
        e.stopImmediatePropagation()
        if (expandedPaneIdRef.current !== null) {
          return
        }
        manager.equalizePaneSizes()
        const paneToFocus = manager.getActivePane() ?? manager.getPanes()[0]
        paneToFocus?.terminal.focus()
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (action.type === 'toggleExpandActivePane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? panes[0]
        if (!pane) {
          return
        }
        toggleExpandPane(pane.id)
        return
      }

      if (action.type === 'setTitle') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onSetTitle(pane.id)
        return
      }

      if (action.type === 'clearPaneTitle') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onClearPaneTitle(pane.id)
        return
      }

      // Cmd+W closes the active split pane (or the whole tab when only one
      // pane remains). Always intercepted here so the tab-level handler in
      // Terminal.tsx never closes the entire tab directly — that would kill
      // every pane instead of just the focused one.
      if (action.type === 'closeActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onRequestClosePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      // Exit expanded mode first so the new split gets proper dimensions
      // (matches Ghostty behavior).
      if (action.type === 'splitActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        splitTerminalPaneWithInheritedCwd({
          manager,
          getManager: () => managerRef.current,
          paneTransports: paneTransportsRef.current,
          paneCwdMap: paneCwdRef.current,
          fallbackCwd,
          pane,
          direction: action.direction,
          source: getKeyboardSplitTelemetrySource()
        })
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!isTerminalImeEnterKeyUp(e)) {
        reconcileHeldImeEnterModifiers(e)
      }
      if (e.key === 'Alt') {
        optionKeyLocation = 0
      }
      const releasedImeEnterModifier =
        e.key === 'Shift' ? 'shift' : e.key === 'Control' ? 'ctrl' : null
      if (releasedImeEnterModifier) {
        const kind = releasedImeEnterModifier
        heldImeEnterModifiers.delete(kind)
        terminalImeEnterModifierKeydowns.delete(kind)
        modifiedEnterChordOwner.release({ kind, code: e.code, timeStamp: e.timeStamp })
      }
      if (e.key !== 'Enter') {
        return
      }

      const observedEnterKeydowns = observedEnterKeydownTimeStamps.get(e.code)
      const enterKeydownWasObserved = observedEnterKeydowns !== undefined
      if (enterKeydownWasObserved && !observedEnterKeydowns.includes(e.timeStamp)) {
        // A balancing keyup copies its keydown timestamp; only the physical release drains it.
        observedEnterKeydowns.shift()
        if (observedEnterKeydowns.length === 0) {
          observedEnterKeydownTimeStamps.delete(e.code)
        }
      }
      if (isWindows && isTerminalImeEnterKeyUp(e)) {
        const originatingChord = modifiedEnterChordOwner.releaseForEnterKeyUp()
        if (originatingChord) {
          e.preventDefault()
          e.stopImmediatePropagation()
          const modifierStillMatches = getImeEnterModifier(e) === originatingChord.kind
          deferredNewlineSender.releaseRedispatchedEnter(
            e,
            modifierStillMatches || originatingChord.terminalModifierKeyDownObserved
              ? originatingChord
              : undefined
          )
          return
        }

        const modifiedEnterKind = getImeEnterModifier(e)
        const manager = managerRef.current
        const keyboardScope = keyboardScopeRef.current
        if (
          modifiedEnterKind &&
          // An observed keydown makes this modifier state rollover, not a swallowed chord.
          !enterKeydownWasObserved &&
          manager &&
          !isEditableTarget(e.target) &&
          (!keyboardScope || keyboardEventBelongsToScope(e, keyboardScope))
        ) {
          const pane = manager.getActivePane() ?? manager.getPanes()[0]
          if (pane && hasPendingTerminalImeComposition(pane.terminal.element)) {
            const action = resolveShortcutEvent({
              key: 'Enter',
              code: e.code,
              metaKey: false,
              ctrlKey: modifiedEnterKind === 'ctrl',
              altKey: false,
              shiftKey: modifiedEnterKind === 'shift',
              repeat: false
            })
            if (action?.type === 'sendInput') {
              e.preventDefault()
              e.stopImmediatePropagation()
              deferredNewlineSender.defer(
                e,
                pane.terminal.element,
                createCapturedInputSender(pane, action.data)
              )
              return
            }
          }
        }
      }

      const modifiedEnterKind = getImeEnterModifier(e)
      if (modifiedEnterKind) {
        modifiedEnterChordOwner.release({
          kind: modifiedEnterKind,
          code: e.code,
          timeStamp: e.timeStamp
        })
      }
      deferredNewlineSender.releaseRedispatchedEnter(e)
    }

    const onNativeOnlyShortcutCompanion = (e: KeyboardEvent): void => {
      if (nativeOnlyShortcutTracker.consumeCompanion(e)) {
        // Why: canceling only the companion keypress prevents Chromium's text
        // insertion without canceling the keydown default used by the OS switch.
        if (e.type === 'keypress') {
          e.preventDefault()
        }
        e.stopImmediatePropagation()
      }
    }

    // Why: modern Chromium can skip keypress and insert via beforeinput; block
    // only this chord's text so an IME commit in the same window remains intact.
    const onNativeOnlyBeforeInput = (e: Event): void => {
      if (!(e instanceof InputEvent) || !nativeOnlyShortcutTracker.shouldSuppressBeforeInput(e)) {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
    }

    const onNativeOnlyBlur = (): void => {
      nativeOnlyShortcutTracker.clear()
      // Why: a chord interrupted by Cmd+Tab or Spotlight never delivers its release, and a carry
      // with no release to spend it sits armed.
      pendingImeChord = null
      heldImeEnterModifiers.clear()
      terminalImeEnterModifierKeydowns.clear()
      modifiedEnterChordOwner.clear()
      deferredNewlineSender.clearRedispatchedEnters()
      observedEnterKeydownTimeStamps.clear()
    }

    const onSwallowedImeChordRelease = (e: KeyboardEvent): void => {
      const chord = pendingImeChord
      if (!chord || !releasesPendingImeChord(chord, e)) {
        return
      }
      // Spent before any gate below can refuse: the key is up, so the press it carried is over
      // however this release is routed. Leaving it armed past a gate is what lets a carry
      // outlive its gesture and answer for someone else's press.
      pendingImeChord = null
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const keyboardScope = keyboardScopeRef.current
      if (keyboardScope && !keyboardEventBelongsToScope(e, keyboardScope)) {
        return
      }
      // The composition ended while the key was down, so the IME took the chord as its cue to
      // commit rather than eating it, and the platform's unmarked replay is on its way.
      if (!isImeOwnedKeyboardEvent(e)) {
        return
      }
      if (isEditableTarget(e.target)) {
        return
      }
      // Matched on the press, consumed on the release. `chord` carries the modifiers as they
      // were when the key went down; `preventDefault` forwards to the real event.
      //
      // The propagation stoppers do not. On a keydown they keep a second handler from acting on
      // the same press, but by this point the action has already run and there is nothing left
      // to race. Cutting a keyup off at window capture only costs: it never reaches xterm's own
      // `_keyUp`, which clears the flags its input path reads, nor any window listener that
      // happens to be registered after this one.
      const pressed: PendingImeChord & ShortcutActionEvent & { stopPropagation: () => void } = {
        ...chord,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => {},
        stopImmediatePropagation: () => {}
      }
      // Same precedence as the keydown path: a chord remapped onto tab.close closes an empty
      // floating panel there, and skipping it here would close the pane instead.
      if (handleEmptyFloatingWorkspacePanelCloseShortcut(pressed, shortcutPlatform, keybindings)) {
        return
      }
      if (matchFileSearchShortcut(chord, shortcutPlatform, keybindings, terminalShortcutPolicy)) {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        const selectedText = normalizeSelectedTextForFileSearch(pane?.terminal.getSelection())
        if (selectedText) {
          e.preventDefault()
          e.stopImmediatePropagation()
          onSearchSelectedText(selectedText)
          return
        }
      }
      const action = resolveShortcutEvent(chord)
      // A native-only chord arms from its press so the OS still sees the gesture; arming it
      // from a release would leave the tracker holding a key that is already up.
      if (!action || action.type === 'switchInputSource') {
        return
      }
      runShortcutAction(pressed, action, manager)
    }

    window.addEventListener('keydown', onModifierDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keypress', onNativeOnlyShortcutCompanion, { capture: true })
    window.addEventListener('keyup', onNativeOnlyShortcutCompanion, { capture: true })
    window.addEventListener('beforeinput', onNativeOnlyBeforeInput, { capture: true })
    window.addEventListener('keyup', onSwallowedImeChordRelease, { capture: true })
    window.addEventListener('blur', onNativeOnlyBlur)
    return () => {
      modifiedEnterChordOwner.clear()
      deferredNewlineSender.clearRedispatchedEnters()
      observedEnterKeydownTimeStamps.clear()
      window.removeEventListener('keydown', onModifierDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keypress', onNativeOnlyShortcutCompanion, { capture: true })
      window.removeEventListener('keyup', onNativeOnlyShortcutCompanion, { capture: true })
      window.removeEventListener('beforeinput', onNativeOnlyBeforeInput, { capture: true })
      pendingImeChord = null
      window.removeEventListener('keyup', onSwallowedImeChordRelease, { capture: true })
      window.removeEventListener('blur', onNativeOnlyBlur)
    }
  }, [
    isActive,
    keyboardScopeRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onSearchSelectedText,
    onRequestClosePane,
    onClearPaneScrollback,
    onSetTitle,
    onClearPaneTitle,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy,
    tabId,
    worktreeId
  ])
}

function getKeyboardSplitTelemetrySource(): 'contextual_tour' | 'keyboard' {
  return useAppStore.getState().activeContextualTourId === 'workspace-agent-sessions'
    ? 'contextual_tour'
    : 'keyboard'
}
