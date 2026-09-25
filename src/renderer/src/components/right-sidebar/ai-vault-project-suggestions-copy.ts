import { translate } from '@/i18n/i18n'

export function projectSuggestionsTitle(count: number): string {
  return count === 1
    ? translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.titleOne',
        '1 project found in your agent sessions'
      )
    : translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.titleMany',
        '{{count}} projects found in your agent sessions',
        { count }
      )
}

export function projectSuggestionsDescription(): string {
  return translate(
    'auto.components.right-sidebar.ai-vault-project-suggestions.description',
    'Git repos where you ran Claude Code, Codex or other agents. Add them to see their sessions grouped by project.'
  )
}

export function projectSuggestionSessions(count: number, agents: string): string {
  return count === 1
    ? translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.sessionsOne',
        '1 session · {{agents}}',
        { agents }
      )
    : translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.sessionsMany',
        '{{count}} sessions · {{agents}}',
        { count, agents }
      )
}

export function addSelectedProjectsLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.addOne',
        'Add 1 project'
      )
    : translate(
        'auto.components.right-sidebar.ai-vault-project-suggestions.addMany',
        'Add {{count}} projects',
        { count }
      )
}

export function dismissProjectSuggestionsLabel(): string {
  return translate(
    'auto.components.right-sidebar.ai-vault-project-suggestions.dismiss',
    "Don't suggest these"
  )
}

export function projectSuggestionsAddFailed(names: string): string {
  return translate(
    'auto.components.right-sidebar.ai-vault-project-suggestions.addFailed',
    "Couldn't add: {{names}}",
    { names }
  )
}
