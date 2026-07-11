/**
 * Compatibility barrel for shared terminal agent-title detection.
 *
 * Why shared: main and renderer both consume OSC titles for facts, stats, and
 * UI state. Keep existing imports stable while the implementation stays split
 * into focused modules that satisfy max-lines. (main's #7612 split into
 * `terminal-title-*` modules coexists — those files stay on disk for their
 * direct `resolveTerminalTitleAgentType`/`synthetic-agent-title` consumers.)
 */

export type { AgentStatus } from './agent-title-core'
export {
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE
} from './agent-title-core'
export { getAgentLabel, isClaudeAgent } from './agent-title-identity'
export {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from './agent-title-status'

// Re-export so existing `agent-detection` importers keep working.
export { AGENT_NAMES, titleHasAgentName } from './agent-name-token-match'
export {
  extractAllOscTitles,
  extractLastOscTitle,
  MAX_OSC_TITLE_CHARS
} from './osc-title-extraction'
export { isShellProcess } from './shell-process-detection'
