import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  RepoHookSettings
} from '../../../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { DEFAULT_REPO_HOOK_SETTINGS } from './repository-hook-defaults'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

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

export function getLocalHookFields(
  t: Translate = translate,
  isFolder = false
): readonly [LocalHookField, LocalHookField] {
  return [
    {
      name: 'setup',
      label: t('auto.components.settings.RepositoryHooksSection.1ecf0b115a', 'Setup script'),
      description: isFolder
        ? t(
            'components.settings.RepositoryHooksSection.folderSetupFieldDescription',
            'Runs after a new workspace is created; create child worktrees, install deps, copy env files.'
          )
        : t(
            'auto.components.settings.RepositoryHooksSection.f0710e1c83',
            'Runs after a new worktree is created; install deps, copy env files, run migrations.'
          ),
      placeholder: t(
        'auto.components.settings.RepositoryHooksSection.a3fc966677',
        '# e.g. pnpm install cp "$ORCA_ROOT_PATH/.env" "$ORCA_WORKTREE_PATH/.env"'
      )
    },
    {
      name: 'archive',
      label: t('auto.components.settings.RepositoryHooksSection.bfdb1266ce', 'Archive script'),
      description: isFolder
        ? t(
            'components.settings.RepositoryHooksSection.folderArchiveFieldDescription',
            'Runs before a workspace is removed.'
          )
        : t(
            'auto.components.settings.RepositoryHooksSection.6f90ebe3fd',
            'Runs before a worktree is archived or removed.'
          ),
      placeholder: t(
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

export function getLocalCommandSourcePolicyNotice(
  {
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
  },
  t: Translate = translate
): LocalCommandSourcePolicyNotice | null {
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
        label: t('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
      }
    : {
        kind: 'action',
        policy: 'local-only',
        label: t('auto.components.settings.RepositoryHooksSection.8bfe65fc60', 'Use local commands')
      }
}

export type HookYamlPresentation = {
  template: string
  archive: boolean
  issueCommand: boolean
}

export function renderYamlScriptPreview(
  hooks: OrcaHooks | null,
  support: Pick<HookYamlPresentation, 'archive' | 'issueCommand'>
): string {
  const formatScript = (key: string, command?: string): string =>
    command ? `\n  ${key}: |\n${command.replace(/^/gm, '    ')}` : ''
  const issueCommand =
    support.issueCommand && hooks?.issueCommand
      ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
      : ''
  return `scripts:${formatScript('setup', hooks?.scripts.setup)}${support.archive ? formatScript('archive', hooks?.scripts.archive) : ''}${issueCommand}`
}

export const GROUP_SETUP_HOOKS_TEMPLATE = 'scripts:\n  setup: |\n    echo "Setting up workspace"'

export function groupHookYamlPresentation(archive: boolean): HookYamlPresentation {
  return {
    template:
      GROUP_SETUP_HOOKS_TEMPLATE +
      (archive ? '\n  archive: |\n    echo "Cleaning up workspace"' : ''),
    archive,
    issueCommand: false
  }
}
