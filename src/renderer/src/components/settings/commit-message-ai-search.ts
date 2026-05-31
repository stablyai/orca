import type { SettingsSearchEntry } from './settings-search'

export const COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Source Control AI',
    description:
      'Adds AI generation to Source Control commit, pull request, and branch-name flows.',
    keywords: [
      'ai',
      'commit',
      'message',
      'generate',
      'agent',
      'claude',
      'codex',
      'source control',
      'enabled'
    ]
  },
  {
    title: 'Agent',
    description: 'Which agent to invoke for Source Control text generation.',
    keywords: ['agent', 'claude', 'codex', 'source control']
  },
  {
    title: 'Default model',
    description: 'Which model Source Control AI uses unless an operation override exists.',
    keywords: ['model', 'haiku', 'sonnet', 'opus', 'gpt']
  },
  {
    title: 'Thinking effort',
    description: 'Reasoning effort level for the selected model. Higher levels are slower.',
    keywords: ['thinking', 'effort', 'reasoning']
  },
  {
    title: 'Advanced model overrides',
    description: 'Optional per-operation model choices for commit messages and PR details.',
    keywords: ['model', 'override', 'commit', 'pull request', 'pr', 'thinking']
  },
  {
    title: 'Commit message prompt',
    description: 'Additional prompt text appended only when generating commit messages.',
    keywords: ['prompt', 'conventional commits', 'gitmoji', 'style']
  },
  {
    title: 'Pull request prompt',
    description: 'Additional prompt text appended only when generating pull request details.',
    keywords: ['prompt', 'pull request', 'pr', 'description', 'template']
  },
  {
    title: 'PR creation defaults',
    description: 'Defaults used when the Create PR composer opens.',
    keywords: ['pull request', 'pr', 'draft', 'template', 'generate', 'open']
  },
  {
    title: 'Custom command',
    description: 'Command line Orca runs to generate the commit message.',
    keywords: ['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder', 'ollama']
  }
]
