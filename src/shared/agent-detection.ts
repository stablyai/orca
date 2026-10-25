/** Stable main/renderer OSC-title imports over focused modules; main terminal-title consumers retain their separate direct imports. */

export type { AgentStatus } from './agent-title-core'
export {
  isClaudeManagementTitle,
  isCursorAgentTitle,
  isCursorNativeAgentTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle,
  shouldSuppressCursorNativeTitle,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE
} from './agent-title-core'
export { isOpenCodeNativeTitle, isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
export { getAgentLabel, isClaudeAgent } from './agent-title-identity'
export {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  normalizeTerminalTitle,
  type AgentIdleStatus
} from './agent-title-status'

export { AGENT_NAMES, titleHasAgentName } from './agent-name-token-match'
export {
  extractAllOscTitles,
  extractLastOscTitle,
  MAX_OSC_TITLE_CHARS,
  MAX_OSC_TITLES_PER_CHUNK
} from './osc-title-extraction'
export { isShellProcess, titleShowsNoAgent } from './shell-process-detection'
