import type { SettingsSearchEntry } from './settings-search'

export const COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'AI Commit Messages',
    description: 'Generate commit messages from staged changes using a local agent.',
    keywords: ['ai', 'commit', 'message', 'generate', 'agent', 'claude', 'codex', 'source control']
  },
  {
    title: 'Agent',
    description: 'Which agent to invoke when generating a commit message.',
    keywords: ['agent', 'claude', 'codex']
  },
  {
    title: 'Model',
    description: 'Which model the selected agent uses to generate the message.',
    keywords: ['model', 'haiku', 'sonnet', 'opus', 'gpt']
  },
  {
    title: 'Thinking effort',
    description: 'Reasoning effort level for the selected model. Higher levels are slower.',
    keywords: ['thinking', 'effort', 'reasoning']
  },
  {
    title: 'Custom prompt',
    description:
      'Optional instructions appended to the base prompt (e.g. Conventional Commits style).',
    keywords: ['prompt', 'conventional commits', 'gitmoji', 'style']
  }
]
