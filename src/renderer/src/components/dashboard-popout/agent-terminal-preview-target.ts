const AGENT_TERMINAL_PREVIEW_SELECTOR = '[data-agent-terminal-preview]'

/** The preview closes its own dialog on the pane-close chord, so workspace close handlers must skip it. */
export function isAgentTerminalPreviewTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(AGENT_TERMINAL_PREVIEW_SELECTOR) !== null
}
