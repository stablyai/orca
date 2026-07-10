/**
 * Compatibility barrel for terminal-title agent detection — used by the main
 * process (stats collection), the renderer (activity indicators, unread
 * badges), and shared siblings.
 *
 * The implementation was split into domain modules in Phase 3 of the title
 * evidence work: identity/label detection → `terminal-title-agent-type`, status
 * classification → `terminal-title-status`, and display normalization →
 * `terminal-title-display`. This barrel is kept so the existing main/mobile/
 * renderer import paths that reference `agent-detection` stay stable.
 */

export { titleHasAgentName } from './agent-name-token-match'
export {
  extractAllOscTitles,
  extractLastOscTitle,
  MAX_OSC_TITLE_CHARS
} from './osc-title-extraction'
export { isShellProcess } from './shell-process-detection'
export {
  getAgentLabel,
  isClaudeAgent,
  isClaudeManagementTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle
} from './terminal-title-agent-type'
export type { AgentStatus } from './terminal-title-status'
export {
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE
} from './terminal-title-status'
export { clearWorkingIndicators, normalizeTerminalTitle } from './terminal-title-display'
