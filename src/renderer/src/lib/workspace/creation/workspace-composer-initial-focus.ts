// Why: with no agent picked the prompt is disabled; focus() on it is a no-op and blocks the fallbacks.
const WORKSPACE_PROMPT_INPUT_SELECTOR = '[data-workspace-prompt-input="true"]:not(:disabled)'
const WORKSPACE_NAME_INPUT_SELECTOR = '[data-workspace-name-input="true"]'
const WORKSPACE_SOURCE_PILL_SELECTOR = '[data-workspace-source-pill="true"]'
const PROJECT_COMBOBOX_TRIGGER_SELECTOR = '[data-project-combobox-root="true"][role="combobox"]'
const LEGACY_REPO_COMBOBOX_TRIGGER_SELECTOR = '[data-repo-combobox-root="true"][role="combobox"]'

export function getWorkspaceComposerInitialFocusTarget(root: ParentNode): HTMLElement | null {
  // Prompt-first: the prompt wins; otherwise name/source for immediate typing/Enter, with combobox fallback where name input is absent.
  return (
    root.querySelector<HTMLElement>(WORKSPACE_PROMPT_INPUT_SELECTOR) ??
    root.querySelector<HTMLElement>(WORKSPACE_NAME_INPUT_SELECTOR) ??
    root.querySelector<HTMLElement>(WORKSPACE_SOURCE_PILL_SELECTOR) ??
    root.querySelector<HTMLElement>(PROJECT_COMBOBOX_TRIGGER_SELECTOR) ??
    root.querySelector<HTMLElement>(LEGACY_REPO_COMBOBOX_TRIGGER_SELECTOR)
  )
}
