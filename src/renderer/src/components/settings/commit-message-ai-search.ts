import type { SettingsSearchEntry } from './settings-search'
import { AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY } from './auto-rename-branch-search'

export const COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  // Why: the auto-name toggle now lives in this pane (it depends on Git AI
  // Author), so its search identity belongs here — matching it surfaces the
  // Enable row when the feature is off, guiding the user to turn it on.
  AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY,
  {
    title: 'Enable Git AI Author',
    description: 'Adds AI generation to git commit, pull request, and branch-name flows.',
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
    description: 'Which agent to invoke for git text generation.',
    keywords: ['agent', 'claude', 'codex', 'source control', 'git ai author']
  },
  {
    title: 'Model',
    description: 'Which model Git AI Author uses unless a per-action model is set.',
    keywords: ['model', 'haiku', 'sonnet', 'opus', 'gpt']
  },
  {
    title: 'Thinking Effort',
    description: 'Reasoning effort level for the selected model. Higher levels are slower.',
    keywords: ['thinking', 'effort', 'reasoning']
  },
  {
    title: 'Advanced',
    description:
      'Override the model and prompt for commit messages, pull requests, and branch names.',
    keywords: [
      'customization',
      'advanced',
      'commit',
      'pull request',
      'pr',
      'branch',
      'name',
      'model',
      'prompt'
    ]
  },
  {
    title: 'Commit Messages',
    description: 'Commit message generation settings.',
    keywords: ['commit', 'message', 'model', 'prompt', 'conventional commits']
  },
  {
    title: 'Commit message model',
    description: 'Optional model choice for commit message generation.',
    keywords: ['model', 'override', 'commit', 'message', 'commit model', 'thinking']
  },
  {
    title: 'Commit message prompt',
    description: 'Additional prompt text appended only when generating commit messages.',
    keywords: ['prompt', 'conventional commits', 'gitmoji', 'style']
  },
  {
    title: 'Pull Requests',
    description: 'Pull request authoring and creation settings.',
    keywords: ['pull request', 'pr', 'model', 'prompt', 'draft', 'template', 'authoring']
  },
  {
    title: 'Pull request model',
    description: 'Optional model choice for pull request detail generation.',
    keywords: ['model', 'override', 'pull request', 'pr', 'pr model', 'thinking']
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
    title: 'Branch Names',
    description: 'Branch name generation settings for auto-named workspaces.',
    keywords: ['branch', 'name', 'rename', 'model', 'prompt', 'slug', 'workspace']
  },
  {
    title: 'Branch name model',
    description: 'Optional model choice for branch name generation.',
    keywords: ['model', 'override', 'branch', 'name', 'branch name model', 'slug', 'thinking']
  },
  {
    title: 'Branch name prompt',
    description: 'Additional prompt text appended only when generating branch names.',
    keywords: ['prompt', 'instructions', 'built-in prompt', 'slug', 'kebab-case']
  },
  {
    title: 'Custom command',
    description: 'Command line Orca runs to generate the commit message.',
    keywords: ['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder', 'ollama']
  }
]
