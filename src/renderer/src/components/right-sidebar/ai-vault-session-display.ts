// Keep renderer imports stable while mobile reuses the shared core; Metro cannot import renderer code.
export type {
  AiVaultSessionDisplayTurn,
  AiVaultSessionPromptPreview
} from '../../../../shared/ai-vault-session-display'
export {
  latestSessionConversationTurn,
  recentSessionConversationTurns,
  sessionDetailConversationTurns,
  sessionModelLabel,
  sessionPromptPreview,
  sessionPreviewSearchText
} from '../../../../shared/ai-vault-session-display'
