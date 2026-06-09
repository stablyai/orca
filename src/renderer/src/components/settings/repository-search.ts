import type { Repo } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'

export function getRepositoryPaneSearchEntries(repo: Repo): SettingsSearchEntry[] {
  const isFolder = isFolderRepo(repo)
  return [
    {
      title: translate("auto.components.settings.repository.search.7e1e456a95", "Display Name"),
      description: translate("auto.components.settings.repository.search.883aad2801", "Project-specific display details for the sidebar and tabs."),
      keywords: [repo.displayName, repo.path, translate("auto.components.settings.repository.search.92af66c7ce", "project name"), translate("auto.components.settings.repository.search.cd73b976d7", "repository name")]
    },
    {
      title: translate("auto.components.settings.repository.search.b24f00294a", "Project Icon"),
      description: translate("auto.components.settings.repository.search.a1f3a2bd47", "Project icon and color used in the sidebar and tabs."),
      keywords: [
        repo.displayName,
        translate("auto.components.settings.repository.search.6438a94c63", "project icon"),
        translate("auto.components.settings.repository.search.b2546efab5", "repository icon"),
        translate("auto.components.settings.repository.search.8d045419b1", "color"),
        translate("auto.components.settings.repository.search.6d8de2f090", "hex"),
        translate("auto.components.settings.repository.search.c1075178cf", "badge"),
        translate("auto.components.settings.repository.search.cb4b4de666", "avatar"),
        translate("auto.components.settings.repository.search.9dc60d7f6d", "github"),
        translate("auto.components.settings.repository.search.1e73e840ff", "emoji"),
        translate("auto.components.settings.repository.search.27733eb6c1", "favicon")
      ]
    },
    ...(isFolder
      ? []
      : [
          {
            title: translate("auto.components.settings.repository.search.094adbe930", "Default Worktree Base"),
            description: translate("auto.components.settings.repository.search.f571081ec4", "Default base branch or ref when creating worktrees."),
            keywords: [repo.displayName, translate("auto.components.settings.repository.search.f41cef5083", "base ref"), translate("auto.components.settings.repository.search.9811f3d152", "branch")]
          },
          {
            title: translate("auto.components.settings.repository.search.443d127b5a", "Worktree Location"),
            description: translate("auto.components.settings.repository.search.cd33a5525e", "Project-specific directory for new worktrees."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.f3e6dee5fe", "worktree path"),
              translate("auto.components.settings.repository.search.a325a89dff", "workspace path"),
              translate("auto.components.settings.repository.search.1ff4f12c0c", "directory"),
              translate("auto.components.settings.repository.search.58d8bca414", "relative"),
              translate("auto.components.settings.repository.search.4733ec2395", "../worktrees")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.1f0f20bbb6", "Sparse Checkout Presets"),
            description: translate("auto.components.settings.repository.search.90a331fd68", "Saved directory sets for sparse worktree creation."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.4f3c0230c2", "sparse"),
              translate("auto.components.settings.repository.search.aa42616e3d", "checkout"),
              translate("auto.components.settings.repository.search.095fca94fe", "preset"),
              translate("auto.components.settings.repository.search.9f5ae26ccd", "presets"),
              translate("auto.components.settings.repository.search.1ff4f12c0c", "directory"),
              translate("auto.components.settings.repository.search.4e2529722c", "directories"),
              translate("auto.components.settings.repository.search.4b9a18a56d", "monorepo")
            ]
          }
        ]),
    {
      title: translate("auto.components.settings.repository.search.c5266c2c9d", "Remove Project"),
      description: translate("auto.components.settings.repository.search.c86478c3d8", "Remove this project from Orca."),
      keywords: [repo.displayName, translate("auto.components.settings.repository.search.3067595d82", "delete"), translate("auto.components.settings.repository.search.6469de5368", "project"), translate("auto.components.settings.repository.search.cc876ca5f2", "repository")]
    },
    ...(isFolder
      ? []
      : [
          {
            title: translate("auto.components.settings.repository.search.eec3995dc6", "Git AI Author"),
            description: translate("auto.components.settings.repository.search.6cc5c65e64", "Project-specific git generation overrides."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.a47f51127e", "source control"),
              translate("auto.components.settings.repository.search.cfad7ce5f3", "ai"),
              translate("auto.components.settings.repository.search.eec39b3de6", "commit message"),
              translate("auto.components.settings.repository.search.5ff7fe1ade", "pull request"),
              translate("auto.components.settings.repository.search.8068d8d0f1", "pr"),
              translate("auto.components.settings.repository.search.917dce844a", "branch name"),
              translate("auto.components.settings.repository.search.130d76dc16", "rename"),
              translate("auto.components.settings.repository.search.fa3131f223", "model"),
              translate("auto.components.settings.repository.search.fff8834983", "prompt")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.01b3377ebc", "Worktree Symlinks"),
            description: translate("auto.components.settings.repository.search.ed885e589f", "Paths to symlink from the primary checkout into newly created worktrees."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.c06adcf136", "symlink"),
              translate("auto.components.settings.repository.search.7e228fc439", "symlinks"),
              translate("auto.components.settings.repository.search.f1c53f2820", "worktree"),
              translate("auto.components.settings.repository.search.3c180a251c", "link"),
              translate("auto.components.settings.repository.search.fcb8fa8144", "shared"),
              translate("auto.components.settings.repository.search.0a3a582794", "env"),
              translate("auto.components.settings.repository.search.84da7fa2d7", "node_modules")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.31bd0a2420", "MCP Configs"),
            description: translate("auto.components.settings.repository.search.3c31801626", "Inspect project-level MCP server config files."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.343f0a508c", "mcp"),
              translate("auto.components.settings.repository.search.16dc7a4637", "model context protocol"),
              translate("auto.components.settings.repository.search.e760e3fae7", ".mcp.json"),
              translate("auto.components.settings.repository.search.26f42fe773", ".cursor/mcp.json"),
              translate("auto.components.settings.repository.search.db11b337c4", ".claude.json"),
              translate("auto.components.settings.repository.search.d73fb47b45", ".claude/mcp.json")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.b79df26937", "Setup Script"),
            description: translate("auto.components.settings.repository.search.baaf70bb37", "Local and shared scripts that run after a new worktree is created."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.8655e3387b", "hooks"),
              translate("auto.components.settings.repository.search.5590388dfa", "setup"),
              translate("auto.components.settings.repository.search.a31b43a7f8", "setup script"),
              translate("auto.components.settings.repository.search.491b05d6e6", "setup command"),
              translate("auto.components.settings.repository.search.6b80f7d3c8", "local settings scripts"),
              translate("auto.components.settings.repository.search.9cad92fe77", "orca.yaml hooks"),
              translate("auto.components.settings.repository.search.bf460fded8", "yaml")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.bce0ca23c6", "Archive Script"),
            description: translate("auto.components.settings.repository.search.acd1157f0c", "Local and shared scripts that run before a worktree is archived."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.8655e3387b", "hooks"),
              translate("auto.components.settings.repository.search.4c17787d7b", "archive"),
              translate("auto.components.settings.repository.search.fbfd2386e8", "archive script"),
              translate("auto.components.settings.repository.search.a1a4c51d58", "archive command"),
              translate("auto.components.settings.repository.search.6b80f7d3c8", "local settings scripts"),
              translate("auto.components.settings.repository.search.9cad92fe77", "orca.yaml hooks"),
              translate("auto.components.settings.repository.search.bf460fded8", "yaml")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.cc11699c3d", "Advanced"),
            description: translate("auto.components.settings.repository.search.d141897c90", "Command source and orca.yaml details."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.19f58d6d89", "advanced"),
              translate("auto.components.settings.repository.search.ed269fad69", "command source"),
              translate("auto.components.settings.repository.search.0432d2fb7c", "local"),
              translate("auto.components.settings.repository.search.603c68b68c", "orca.yaml"),
              translate("auto.components.settings.repository.search.fcb8fa8144", "shared"),
              translate("auto.components.settings.repository.search.1d90a6cfbb", "both"),
              translate("auto.components.settings.repository.search.f1e1bfa89f", "source"),
              translate("auto.components.settings.repository.search.5e9445bbfd", "authoritative")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.cdfe398068", "When to Run Setup"),
            description: translate("auto.components.settings.repository.search.c00a549e03", "Choose the default behavior when a setup script is available."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.f9d84b7971", "setup run policy"),
              translate("auto.components.settings.repository.search.80c490b012", "ask"),
              translate("auto.components.settings.repository.search.a69c5cbe90", "run by default"),
              translate("auto.components.settings.repository.search.c5e8bdbcbb", "skip by default")
            ]
          },
          {
            title: translate("auto.components.settings.repository.search.d86ea12d16", "Custom GitHub Issue Command"),
            description:
              translate("auto.components.settings.repository.search.d42d1e49c0", "File-based linked-issue command configured via orca.yaml and optional local override."),
            keywords: [
              repo.displayName,
              translate("auto.components.settings.repository.search.2011a6a4f2", "github issue command"),
              translate("auto.components.settings.repository.search.66b584bd6c", "issue command"),
              translate("auto.components.settings.repository.search.ec70364df2", "workflow"),
              translate("auto.components.settings.repository.search.9dc60d7f6d", "github"),
              translate("auto.components.settings.repository.search.603c68b68c", "orca.yaml"),
              translate("auto.components.settings.repository.search.bc7e504b8e", ".orca/issue-command")
            ]
          }
        ])
  ]
}
