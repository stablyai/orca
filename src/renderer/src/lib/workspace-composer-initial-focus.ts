import { getShortcutPlatform } from './shortcut-platform'

const WORKSPACE_NAME_INPUT_SELECTOR = '[data-workspace-name-input="true"]'
const WORKSPACE_SOURCE_PILL_SELECTOR = '[data-workspace-source-pill="true"]'
const PROJECT_COMBOBOX_SHELL_SELECTOR = 'div[data-project-combobox-root="true"]'
const PROJECT_COMBOBOX_TRIGGER_SELECTOR = '[data-project-combobox-root="true"][role="combobox"]'
const LEGACY_REPO_COMBOBOX_TRIGGER_SELECTOR = '[data-repo-combobox-root="true"][role="combobox"]'

type ComposerProjectSelectShortcutEvent = {
  key: string
  code?: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
  }
}

export function getWorkspaceComposerInitialFocusTarget(root: ParentNode): HTMLElement | null {
  // Why: most opens already have a project selected; land on the name/source
  // field so users can type or press Enter immediately. The source pill
  // replaces the input when a linked item or branch is pre-filled. Keep
  // combobox fallbacks for surfaces that omit the smart name field.
  return (
    root.querySelector<HTMLElement>(WORKSPACE_NAME_INPUT_SELECTOR) ??
    root.querySelector<HTMLElement>(WORKSPACE_SOURCE_PILL_SELECTOR) ??
    root.querySelector<HTMLElement>(PROJECT_COMBOBOX_TRIGGER_SELECTOR) ??
    root.querySelector<HTMLElement>(LEGACY_REPO_COMBOBOX_TRIGGER_SELECTOR)
  )
}

/** Cmd/Ctrl+. — composer-local, not a remappable app command. */
export function isComposerProjectSelectShortcut(
  event: ComposerProjectSelectShortcutEvent
): boolean {
  if (event.isComposing || event.nativeEvent?.isComposing) {
    return false
  }
  if (event.altKey || event.shiftKey) {
    return false
  }
  // Why: macOS composition can rewrite event.key for punctuation; prefer code,
  // and keep key === '.' for environments that omit code.
  if (event.code !== 'Period' && event.key !== '.') {
    return false
  }
  const platform = getShortcutPlatform()
  return platform === 'darwin'
    ? Boolean(event.metaKey) && !event.ctrlKey
    : Boolean(event.ctrlKey) && !event.metaKey
}

/** Opens (and focuses) the project picker — Cmd/Ctrl+. from the create modal. */
export function openWorkspaceComposerProjectSelect(root: ParentNode): boolean {
  // Why: shell click always opens even when the field already has focus;
  // bare focus() would no-op and leave a closed list.
  const shell = root.querySelector<HTMLElement>(PROJECT_COMBOBOX_SHELL_SELECTOR)
  if (!shell) {
    return false
  }
  shell.click()
  return true
}
