// Why: the pure preview/search-text core now lives in /shared so mobile can
// reuse it (Metro can't import renderer). Re-export for renderer import parity.
export type { AiVaultSessionDisplayTurn } from '../../../../shared/ai-vault-session-display'
export {
  latestSessionConversationTurn,
  recentSessionConversationTurns,
  sessionDetailConversationTurns,
  sessionModelLabel,
  sessionPreviewSearchText
} from '../../../../shared/ai-vault-session-display'
