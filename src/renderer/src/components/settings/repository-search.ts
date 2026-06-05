import type { Repo } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { SettingsSearchEntry } from './settings-search'

export function getRepositoryPaneSearchEntries(repo: Repo): SettingsSearchEntry[] {
  const isFolder = isFolderRepo(repo)
  return [
    {
      title: 'Display Name',
      description: 'Project-specific display details for the sidebar and tabs.',
      keywords: [repo.displayName, repo.path, 'project name', 'repository name']
    },
    {
      title: 'Project Icon',
      description: 'Project icon and color used in the sidebar and tabs.',
      keywords: [
        repo.displayName,
        'project icon',
        'repository icon',
        'color',
        'hex',
        'badge',
        'avatar',
        'github',
        'emoji',
        'favicon'
      ]
    },
    ...(isFolder
      ? []
      : [
          {
            title: 'Default Worktree Base',
            description: 'Default base branch or ref when creating worktrees.',
            keywords: [repo.displayName, 'base ref', 'branch']
          },
          {
            title: 'Worktree Location',
            description: 'Project-specific directory for new worktrees.',
            keywords: [
              repo.displayName,
              'worktree path',
              'workspace path',
              'directory',
              'relative',
              '../worktrees'
            ]
          },
          {
            title: 'Sparse Checkout Presets',
            description: 'Saved directory sets for sparse worktree creation.',
            keywords: [
              repo.displayName,
              'sparse',
              'checkout',
              'preset',
              'presets',
              'directory',
              'directories',
              'monorepo'
            ]
          }
        ]),
    {
      title: 'Remove Project',
      description: 'Remove this project from Orca.',
      keywords: [repo.displayName, 'delete', 'project', 'repository']
    },
    ...(isFolder
      ? []
      : [
          {
            title: 'Git AI Author',
            description: 'Project-specific git generation overrides.',
            keywords: [
              repo.displayName,
              'source control',
              'ai',
              'commit message',
              'pull request',
              'pr',
              'branch name',
              'rename',
              'model',
              'prompt'
            ]
          },
          {
            title: 'Worktree Symlinks',
            description: 'Paths to symlink from the primary checkout into newly created worktrees.',
            keywords: [
              repo.displayName,
              'symlink',
              'symlinks',
              'worktree',
              'link',
              'shared',
              'env',
              'node_modules'
            ]
          },
          {
            title: 'MCP Configs',
            description: 'Inspect project-level MCP server config files.',
            keywords: [
              repo.displayName,
              'mcp',
              'model context protocol',
              '.mcp.json',
              '.cursor/mcp.json',
              '.claude.json',
              '.claude/mcp.json'
            ]
          },
          {
            title: 'Setup Script',
            description: 'Local and shared scripts that run after a new worktree is created.',
            keywords: [
              repo.displayName,
              'hooks',
              'setup',
              'setup script',
              'setup command',
              'local settings scripts',
              'orca.yaml hooks',
              'yaml'
            ]
          },
          {
            title: 'Archive Script',
            description: 'Local and shared scripts that run before a worktree is archived.',
            keywords: [
              repo.displayName,
              'hooks',
              'archive',
              'archive script',
              'archive command',
              'local settings scripts',
              'orca.yaml hooks',
              'yaml'
            ]
          },
          {
            title: 'Advanced',
            description: 'Command source and orca.yaml details.',
            keywords: [
              repo.displayName,
              'advanced',
              'command source',
              'local',
              'orca.yaml',
              'shared',
              'both',
              'source',
              'authoritative'
            ]
          },
          {
            title: 'When to Run Setup',
            description: 'Choose the default behavior when a setup script is available.',
            keywords: [
              repo.displayName,
              'setup run policy',
              'ask',
              'run by default',
              'skip by default'
            ]
          },
          {
            title: 'Custom GitHub Issue Command',
            description:
              'File-based linked-issue command configured via orca.yaml and optional local override.',
            keywords: [
              repo.displayName,
              'github issue command',
              'issue command',
              'workflow',
              'github',
              'orca.yaml',
              '.orca/issue-command'
            ]
          }
        ])
  ]
}
