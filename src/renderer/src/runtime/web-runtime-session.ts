export {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-terminal-surface-id'

export { isWebRuntimeSessionActive } from './web-runtime-session-environment'
export type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
export {
  createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft
} from './web-runtime-terminal-creation'
export { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
export { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
export { activateWebRuntimeSessionWorktree } from './web-runtime-worktree-activation'
export { activateWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
export type { WebRuntimeSessionTabCloseOutcome } from './web-runtime-session-tab-lifecycle'
export { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
export { moveWebRuntimeSessionTab } from './web-runtime-session-tab-move'
export {
  splitWebRuntimeTerminal,
  consumePendingWebRuntimeSplitMirrorTelemetry,
  closeWebRuntimeTerminal,
  updateWebRuntimePaneLayout,
  setWebRuntimeTabProps,
  clearWebRuntimeTerminalBuffer
} from './web-runtime-terminal-actions'
export type { WebRuntimeSplitSource } from './web-runtime-split-focus'
