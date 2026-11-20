// Why: Electron rebuilds its application menu on every keybinding and locale
// update so labels and shortcut hints track the live registry; the Tauri menu
// is built once, so the renderer pushes each change back through
// `poc_menu_set_hints`. `baseText` is the i18n-aware label, `hint` is the
// rendered chord list or null to clear.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getEffectiveKeybindingsForAction } from '../../../shared/keybindings/effective'
import { formatKeybindingList } from '../../../shared/keybindings/formatting'
import type { KeybindingActionId } from '../../../shared/keybindings/types'
import { translate } from '../i18n/i18n'
import { shortcutPlatform } from '../app-shell/chrome/app-window-chrome'
import { useAppStore } from '../store'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

export type TauriMenuItemUpdate = {
  id: string
  /** i18n-aware label sent as `baseText`; Rust renders it verbatim with hint. */
  baseText: string
  /** Rendered chord hint; null clears any previously pushed hint. */
  hint: string | null
}

export type TauriMenuHintBinding = {
  id: string
  actionId: KeybindingActionId
  /** English fallback matching application_menu_spec's display label. */
  baseText: string
  /** Renderer i18n key (`menu.*`) used when a non-English locale is active. */
  i18nKey?: string
}

// Menu items whose hint text follows a rebindable action, keyed by their
// application_menu_spec id so the Rust command can find them by `menu.get`.
export const TAURI_MENU_HINT_BINDINGS: readonly TauriMenuHintBinding[] = [
  { id: 'file-settings', actionId: 'app.settings', baseText: 'Settings', i18nKey: 'menu.settings' },
  {
    id: 'view-force-reload',
    actionId: 'app.forceReload',
    baseText: 'Force Reload',
    i18nKey: 'menu.forceReload'
  },
  { id: 'view-zoom-in', actionId: 'zoom.in', baseText: 'Zoom In', i18nKey: 'menu.zoomIn' },
  { id: 'view-zoom-out', actionId: 'zoom.out', baseText: 'Zoom Out', i18nKey: 'menu.zoomOut' },
  {
    id: 'view-zoom-reset',
    actionId: 'zoom.reset',
    baseText: 'Reset Size',
    i18nKey: 'menu.resetSize'
  },
  {
    id: 'view-toggle-left-sidebar',
    actionId: 'sidebar.left.toggle',
    baseText: 'Toggle Left Sidebar',
    i18nKey: 'menu.toggleLeftSidebar'
  },
  {
    id: 'view-toggle-right-sidebar',
    actionId: 'sidebar.right.toggle',
    baseText: 'Toggle Right Sidebar',
    i18nKey: 'menu.toggleRightSidebar'
  },
  {
    id: 'view-toggle-worktree-palette',
    actionId: 'worktree.palette',
    baseText: 'Open Worktree Palette',
    i18nKey: 'menu.openWorktreePalette'
  }
]

// Menu items that are not rebindable but still need a locale-aware label.
// `hint: null` keeps the spec''s static label when no translation applies.
const TAURI_MENU_LABEL_BINDINGS: readonly { id: string; i18nKey: string; baseText: string }[] = [
  { id: 'menu-section-file', i18nKey: 'menu.file', baseText: 'File' },
  { id: 'menu-section-edit', i18nKey: 'menu.edit', baseText: 'Edit' },
  { id: 'menu-section-view', i18nKey: 'menu.view', baseText: 'View' },
  { id: 'menu-section-window', i18nKey: 'menu.window', baseText: 'Window' },
  { id: 'menu-section-help', i18nKey: 'menu.help', baseText: 'Help' },
  { id: 'menu-section-appearance', i18nKey: 'menu.appearance', baseText: 'Appearance' },
  { id: 'file-quit', i18nKey: 'menu.exit', baseText: 'Exit' },
  {
    id: 'help-check-for-updates',
    i18nKey: 'menu.checkForUpdates',
    baseText: 'Check for Updates...'
  },
  { id: 'help-crash-report', i18nKey: 'menu.reportCrash', baseText: 'Report Crash...' },
  { id: 'help-feature-tour', i18nKey: 'menu.exploreOrca', baseText: 'Explore Orca' },
  {
    id: 'help-setup-guide',
    i18nKey: 'menu.gettingStarted',
    baseText: 'Getting Started with Orca'
  },
  { id: 'edit-copy', i18nKey: 'menu.copy', baseText: 'Copy' },
  { id: 'edit-paste', i18nKey: 'menu.paste', baseText: 'Paste' },
  { id: 'edit-select-all', i18nKey: 'menu.selectAll', baseText: 'Select All' },
  { id: 'view-reload', i18nKey: 'menu.reload', baseText: 'Reload' },
  { id: 'view-toggle-status-bar', i18nKey: 'menu.showStatusBar', baseText: 'Show Status Bar' },
  {
    id: 'view-appearance-tasks',
    i18nKey: 'menu.showTasksButton',
    baseText: 'Show Tasks Button'
  },
  {
    id: 'view-appearance-automations',
    i18nKey: 'menu.showAutomationsButton',
    baseText: 'Show Automations Button'
  },
  {
    id: 'view-appearance-mobile',
    i18nKey: 'menu.showMobileButton',
    baseText: 'Show Orca Mobile Button'
  },
  {
    id: 'view-appearance-titlebar',
    i18nKey: 'menu.showTitlebarAppName',
    baseText: 'Show Titlebar App Name'
  }
]

export function computeTauriMenuUpdates(
  platform: NodeJS.Platform,
  overrides?: Parameters<typeof getEffectiveKeybindingsForAction>[2]
): TauriMenuItemUpdate[] {
  const updates: TauriMenuItemUpdate[] = []
  for (const { id, actionId, baseText, i18nKey } of TAURI_MENU_HINT_BINDINGS) {
    let bindings: string[] = []
    try {
      bindings = getEffectiveKeybindingsForAction(actionId, platform, overrides)
    } catch {
      bindings = []
    }
    updates.push({
      id,
      baseText: i18nKey ? translate(i18nKey, baseText) : baseText,
      hint: bindings.length ? formatKeybindingList(bindings, platform) : null
    })
  }
  for (const { id, i18nKey, baseText } of TAURI_MENU_LABEL_BINDINGS) {
    updates.push({ id, baseText: translate(i18nKey, baseText), hint: null })
  }
  return updates
}

export function useTauriMenuText(): void {
  const keybindings = useAppStore((s) => s.keybindings)
  const { i18n } = useTranslation()
  const lastFingerprint = useRef<string | null>(null)
  useEffect(() => {
    if (!isTauriNativeHost()) {
      return
    }
    const updates = computeTauriMenuUpdates(shortcutPlatform, keybindings)
    const fingerprint = updates.map((u) => `${u.id}=${u.baseText}|${u.hint ?? ''}`).join('|')
    if (lastFingerprint.current === fingerprint) {
      return
    }
    lastFingerprint.current = fingerprint
    void invokeNative('poc_menu_set_hints', { args: { updates } }).catch(() => {})
  }, [keybindings, i18n.language])
}
