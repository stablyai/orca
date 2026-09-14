import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  RepoHookSettings
} from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import { translate } from '@/i18n/i18n'

export type LocalHookName = 'setup' | 'archive'
export type LocalHookField = {
  name: LocalHookName
  label: string
  description: string
  placeholder: string
}
export type HookSettingsPolicyDraft = Partial<
  Pick<RepoHookSettings, 'setupRunPolicy' | 'setupAgentStartupPolicy' | 'commandSourcePolicy'>
>

export function getLocalHookFields(): readonly [LocalHookField, LocalHookField] {
  return [
    {
      name: 'setup',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.52b31baf02',
        'Setup Script'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.f0710e1c83',
        'Runs after a new worktree is created; install deps, copy env files, run migrations.'
      ),
      placeholder: translate(
        'auto.components.settings.RepositoryHooksSection.a3fc966677',
        '# e.g. pnpm install cp "$ORCA_ROOT_PATH/.env" "$ORCA_WORKTREE_PATH/.env"'
      )
    },
    {
      name: 'archive',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.9a100323ff',
        'Archive Script'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.6f90ebe3fd',
        'Runs before a worktree is archived or removed.'
      ),
      placeholder: translate(
        'auto.components.settings.RepositoryHooksSection.9b821fa19d',
        '# e.g. echo "Cleaning up $ORCA_WORKSPACE_NAME"'
      )
    }
  ]
}

export function getHookSettingsDraft(hookSettings: Repo['hookSettings']): RepoHookSettings {
  return {
    ...DEFAULT_REPO_HOOK_SETTINGS,
    ...hookSettings,
    scripts: {
      ...DEFAULT_REPO_HOOK_SETTINGS.scripts,
      ...hookSettings?.scripts
    }
  }
}

export function areHookSettingsDraftsEqual(a: RepoHookSettings, b: RepoHookSettings): boolean {
  return (
    a.mode === b.mode &&
    a.setupRunPolicy === b.setupRunPolicy &&
    a.setupAgentStartupPolicy === b.setupAgentStartupPolicy &&
    a.commandSourcePolicy === b.commandSourcePolicy &&
    a.scripts.setup === b.scripts.setup &&
    a.scripts.archive === b.scripts.archive
  )
}

export type LocalCommandSourcePolicyNotice =
  | { kind: 'checking' }
  | { kind: 'action'; policy: 'local-only' | 'run-both'; label: string }

export function getLocalCommandSourcePolicyNotice({
  hooksInspectionReady,
  currentPolicy,
  setupScript,
  archiveScript,
  hasSharedScript
}: {
  hooksInspectionReady: boolean
  currentPolicy: HookCommandSourcePolicy
  setupScript: string | undefined
  archiveScript: string | undefined
  hasSharedScript: boolean
}): LocalCommandSourcePolicyNotice | null {
  if ((!setupScript?.trim() && !archiveScript?.trim()) || currentPolicy !== 'shared-only') {
    return null
  }
  if (!hooksInspectionReady) {
    return { kind: 'checking' }
  }
  return hasSharedScript
    ? {
        kind: 'action',
        policy: 'run-both',
        label: translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
      }
    : {
        kind: 'action',
        policy: 'local-only',
        label: translate(
          'auto.components.settings.RepositoryHooksSection.8bfe65fc60',
          'Use local commands'
        )
      }
}

export function renderYamlScriptPreview(hooks: OrcaHooks | null): string {
  const formatScript = (key: string, command?: string): string =>
    command ? `\n  ${key}: |\n${command.replace(/^/gm, '    ')}` : ''
  const issueCommand = hooks?.issueCommand
    ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
    : ''
  return `scripts:${formatScript('setup', hooks?.scripts.setup)}${formatScript('archive', hooks?.scripts.archive)}${issueCommand}`
}
