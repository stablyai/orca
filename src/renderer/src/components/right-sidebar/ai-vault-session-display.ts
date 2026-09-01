// Why: the pure preview/search-text core now lives in /shared so mobile can
// reuse it (Metro can't import renderer). Re-export for renderer import parity.
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

export function sessionResumeArgsLabel(args: readonly string[]): string | null {
  if (args.length === 0) {
    return null
  }
  return args.map(formatResumeArgument).join(' ')
}

function formatResumeArgument(arg: string): string {
  return arg.length > 0 && !/[\s"'\\]/.test(arg) ? arg : JSON.stringify(arg)
}
