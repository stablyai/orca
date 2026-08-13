import {
  keybindingMatchesAction,
  matchKeybindingDigitIndex,
  type KeybindingActionId,
  type KeybindingMatchOptions,
  type KeybindingOverrides,
  type PhysicalModifierToken
} from './keybindings'
import { resolveAccountShortcut } from './provider-account-shortcut-policy'

export type WindowShortcutInput = {
  type?: string
  key?: string
  code?: string
  alt?: boolean
  meta?: boolean
  control?: boolean
  shift?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  // Set only by the double-tap detector; threads the synthetic input through
  // the main-process resolver so allowlisted actions can fire on double-tap.
  doubleTapModifier?: PhysicalModifierToken
}

export type WindowShortcutAction =
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'openSettings' }
  | { type: 'forceReload' }
  | { type: 'toggleWorktreePalette' }
  | { type: 'toggleFloatingTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'toggleQuickCommandsMenu' }
  | { type: 'openNewWorkspace' }
  | { type: 'deleteCurrentWorkspace' }
  | { type: 'openWorkspaceBoard' }
  | { type: 'openTasks' }
  | { type: 'switchRecentTab' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'jumpToTabIndex'; index: number }
  | { type: 'switchProviderAccountIndex'; provider: 'claude' | 'codex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }

type WindowShortcutResolveOptions = KeybindingMatchOptions

function platformPrimaryModifier(
  input: Pick<WindowShortcutInput, 'meta' | 'control'>,
  platform: NodeJS.Platform
): boolean {
  return platform === 'darwin' ? Boolean(input.meta) : Boolean(input.control)
}

export function isWindowShortcutModifierChord(
  input: Pick<WindowShortcutInput, 'meta' | 'control' | 'alt'>,
  platform: NodeJS.Platform
): boolean {
  return platformPrimaryModifier(input, platform) && !input.alt
}

export function matchesRecentTabSwitcherChord(
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides,
  options: WindowShortcutResolveOptions = {}
): boolean {
  const control = Boolean(input.control ?? input.ctrlKey)
  const meta = Boolean(input.meta ?? input.metaKey)
  const alt = Boolean(input.alt ?? input.altKey)
  if (input.code !== 'Tab' || !control || meta || alt) {
    return false
  }
  // Why: the Ctrl+Tab switcher is a held-key interaction where Shift reverses
  // direction. Gate the whole family on the configurable unshifted binding.
  return keybindingMatchesAction(
    'tab.previousRecent',
    {
      key: input.key,
      code: input.code,
      alt,
      meta,
      control,
      shift: false,
      altKey: alt,
      metaKey: meta,
      ctrlKey: control,
      shiftKey: false
    },
    platform,
    keybindings,
    options
  )
}

function isControlKey(input: WindowShortcutInput): boolean {
  return (
    input.code === 'ControlLeft' ||
    input.code === 'ControlRight' ||
    input.code === 'Control' ||
    input.key === 'Control'
  )
}

function isTabKey(input: WindowShortcutInput): boolean {
  return input.code === 'Tab' || input.key === 'Tab'
}

export function isRecentTabSwitcherCommitRelease(input: WindowShortcutInput): boolean {
  if (input.type !== 'keyUp' && input.type !== 'keyup') {
    return false
  }
  if (isControlKey(input)) {
    return true
  }
  const control = input.control ?? input.ctrlKey
  // Why: some Electron surfaces report the final Ctrl+Tab release as Tab
  // keyup after Control is already up, so commit instead of stranding the UI.
  return isTabKey(input) && control === false
}

function actionMatches(
  actionId: KeybindingActionId,
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  options: WindowShortcutResolveOptions
): boolean {
  return keybindingMatchesAction(actionId, input, platform, keybindings, options)
}

export function nativeZoomCommandMatchesKeybindings(
  direction: 'in' | 'out',
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  const primary =
    platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
  const actionId = direction === 'in' ? 'zoom.in' : 'zoom.out'
  const candidates =
    direction === 'in'
      ? [
          { key: '=', code: 'Equal', shift: false },
          { key: '+', code: 'Equal', shift: true },
          { key: 'Add', code: 'NumpadAdd', shift: false }
        ]
      : [
          { key: '-', code: 'Minus', shift: false },
          { key: 'Subtract', code: 'NumpadSubtract', shift: false }
        ]

  return candidates.some((candidate) =>
    keybindingMatchesAction(
      actionId,
      { ...primary, alt: false, ...candidate },
      platform,
      keybindings,
      options
    )
  )
}

/** Resolves a window keybinding input to its shortcut action, or null when it matches no action. */
export function resolveWindowShortcutAction(
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides,
  options: WindowShortcutResolveOptions = {}
): WindowShortcutAction | null {
  if (actionMatches('worktree.history.back', input, platform, keybindings, options)) {
    return {
      type: 'worktreeHistoryNavigate',
      direction: 'back'
    }
  }

  if (actionMatches('worktree.history.forward', input, platform, keybindings, options)) {
    return {
      type: 'worktreeHistoryNavigate',
      direction: 'forward'
    }
  }

  if (actionMatches('floatingTerminal.toggle', input, platform, keybindings, options)) {
    return { type: 'toggleFloatingTerminal' }
  }

  if (actionMatches('zoom.in', input, platform, keybindings, options)) {
    return { type: 'zoom', direction: 'in' }
  }

  if (actionMatches('zoom.out', input, platform, keybindings, options)) {
    return { type: 'zoom', direction: 'out' }
  }

  if (actionMatches('zoom.reset', input, platform, keybindings, options)) {
    return { type: 'zoom', direction: 'reset' }
  }

  if (actionMatches('app.settings', input, platform, keybindings, options)) {
    return { type: 'openSettings' }
  }

  if (actionMatches('app.forceReload', input, platform, keybindings, options)) {
    return { type: 'forceReload' }
  }

  if (actionMatches('worktree.palette', input, platform, keybindings, options)) {
    return { type: 'toggleWorktreePalette' }
  }

  if (actionMatches('sidebar.left.toggle', input, platform, keybindings, options)) {
    return { type: 'toggleLeftSidebar' }
  }

  if (actionMatches('sidebar.right.toggle', input, platform, keybindings, options)) {
    return { type: 'toggleRightSidebar' }
  }

  if (actionMatches('worktree.quickOpen', input, platform, keybindings, options)) {
    return { type: 'openQuickOpen' }
  }

  // Why: Cmd/Ctrl+N opens the new-workspace composer. Routed through the
  // main process so it reaches the renderer even when focus lives inside
  // a contentEditable surface (markdown rich editor) or a browser guest
  // webContents, both of which bypass the renderer's window-level keydown.
  // Shift is accepted for compatibility with the former Create-from shortcut;
  // the unified composer now exposes source switching inside the name field.
  if (actionMatches('workspace.create', input, platform, keybindings, options)) {
    return { type: 'openNewWorkspace' }
  }

  if (actionMatches('workspace.delete', input, platform, keybindings, options)) {
    return { type: 'deleteCurrentWorkspace' }
  }

  if (actionMatches('workspace.openBoard', input, platform, keybindings, options)) {
    return { type: 'openWorkspaceBoard' }
  }

  if (actionMatches('voice.dictation', input, platform, keybindings, options)) {
    return { type: 'dictationKeyDown' }
  }

  if (actionMatches('view.tasks', input, platform, keybindings, options)) {
    return { type: 'openTasks' }
  }

  if (actionMatches('tab.previousRecent', input, platform, keybindings, options)) {
    return { type: 'switchRecentTab' }
  }

  // Why: the two ranges live in different scopes (no shared conflictGroup), so a
  // user is free to map both onto the same modifier without it being blocked as a
  // conflict. Checking workspace first gives that overlap deterministic
  // precedence — workspace wins — matching the historical Cmd-before-Ctrl order.
  const worktreeIndex = matchKeybindingDigitIndex(
    'workspace.selectByIndex',
    input,
    platform,
    keybindings,
    options
  )
  if (worktreeIndex !== null) {
    return { type: 'jumpToWorktreeIndex', index: worktreeIndex }
  }

  const tabIndex = matchKeybindingDigitIndex(
    'tab.selectByIndex',
    input,
    platform,
    keybindings,
    options
  )
  if (tabIndex !== null) {
    return { type: 'jumpToTabIndex', index: tabIndex }
  }

  const accountIndex = resolveAccountShortcut(input, platform, keybindings, options)
  if (accountIndex) {
    return accountIndex
  }

  if (actionMatches('tab.openQuickCommandsMenu', input, platform, keybindings, options)) {
    return { type: 'toggleQuickCommandsMenu' }
  }

  // Why: this helper is the explicit allowlist for main-process interception.
  // Anything not listed here must keep flowing to the renderer/PTTY so readline
  // chords like Ctrl+R, Ctrl+U, and Ctrl+E are not accidentally stolen while
  // terminals own focus.
  return null
}

// Why: moved to window-shortcut-action-id.ts (action -> keybinding id direction) to keep this
// file under its line budget; re-exported so existing imports of this module don't break.
export {
  getWindowShortcutActionId,
  windowShortcutActionCapturesTerminal
} from './window-shortcut-action-id'
