import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { BaseRefPicker } from './BaseRefPicker'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/external-worktree-visibility'

type RepositoryWorktreeDefaultsUpdate = Pick<Repo, 'worktreeBasePath' | 'worktreeBaseRef'> & {
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
}

type RepositoryWorktreeDefaultsSectionProps = {
  repo: Repo
  settings: Pick<GlobalSettings, 'workspaceDir' | 'worktreeVisibilityDefaults'> | null
  updateRepo: (
    repoId: string,
    updates: Partial<RepositoryWorktreeDefaultsUpdate>
  ) => void | Promise<boolean>
  refreshRepo: (repoId: string) => void | Promise<unknown>
  forceVisible: boolean
}

export function RepositoryWorktreeDefaultsSection({
  repo,
  settings,
  updateRepo,
  refreshRepo,
  forceVisible
}: RepositoryWorktreeDefaultsSectionProps): React.JSX.Element {
  const isLegacyRepo = isLegacyRepoForExternalWorktreeVisibility(repo)
  const globalVisibility =
    settings?.worktreeVisibilityDefaults?.external ?? (isLegacyRepo ? 'show' : 'hide')
  const effectiveVisibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepo,
    settings?.worktreeVisibilityDefaults
  )
  const updateVisibility = async (value: string): Promise<void> => {
    const visibility = value === 'global' ? null : value === 'show' ? 'show' : 'hide'
    let updated = await updateRepo(repo.id, { externalWorktreeVisibility: visibility })
    if (updated === false && visibility === null) {
      updated = await updateRepo(repo.id, { externalWorktreeVisibility: effectiveVisibility })
    }
    if (updated !== false) {
      await refreshRepo(repo.id)
    }
  }
  return (
    <>
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryPane.externalWorktrees',
          'External worktrees'
        )}
        description={translate(
          'auto.components.settings.RepositoryPane.externalWorktreesDescription',
          'Override whether worktrees created outside Orca appear for this project.'
        )}
        keywords={[repo.displayName, 'external', 'non-Orca', 'visibility', 'sidebar']}
        className="space-y-2"
        forceVisible={forceVisible}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label className="text-sm font-semibold">
              {translate(
                'auto.components.settings.RepositoryPane.externalWorktrees',
                'External worktrees'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {repo.externalWorktreeVisibility === undefined
                ? translate(
                    'auto.components.settings.RepositoryPane.externalWorktreesInherited',
                    'Using global: {{value0}}',
                    {
                      value0:
                        effectiveVisibility === 'show'
                          ? translate('auto.components.settings.RepositoryPane.show', 'Show')
                          : translate('auto.components.settings.RepositoryPane.hide', 'Hide')
                    }
                  )
                : translate(
                    'auto.components.settings.RepositoryPane.externalWorktreesGlobal',
                    'Global default: {{value0}}',
                    {
                      value0:
                        globalVisibility === 'show'
                          ? translate('auto.components.settings.RepositoryPane.show', 'Show')
                          : translate('auto.components.settings.RepositoryPane.hide', 'Hide')
                    }
                  )}
            </p>
          </div>
          <Select
            value={repo.externalWorktreeVisibility ?? 'global'}
            onValueChange={(value) => void updateVisibility(value)}
          >
            <SelectTrigger size="sm" className="h-8 w-[132px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">
                {translate('auto.components.settings.RepositoryPane.useGlobal', 'Use global')}
              </SelectItem>
              <SelectItem value="show">
                {translate('auto.components.settings.RepositoryPane.show', 'Show')}
              </SelectItem>
              <SelectItem value="hide">
                {translate('auto.components.settings.RepositoryPane.hide', 'Hide')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryPane.f88db4fece',
          'Default Worktree Base'
        )}
        description={translate(
          'auto.components.settings.RepositoryPane.8984d06520',
          'Default base branch or ref when creating worktrees.'
        )}
        keywords={[repo.displayName, 'base ref', 'branch']}
        className="space-y-3"
        forceVisible={forceVisible}
      >
        <Label className="text-sm font-semibold">
          {translate('auto.components.settings.RepositoryPane.f88db4fece', 'Default Worktree Base')}
        </Label>
        <BaseRefPicker
          repoId={repo.id}
          hostId={getRepoExecutionHostId(repo)}
          currentBaseRef={repo.worktreeBaseRef}
          onSelect={(ref) => updateRepo(repo.id, { worktreeBaseRef: ref })}
          onUsePrimary={() => updateRepo(repo.id, { worktreeBaseRef: undefined })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate('auto.components.settings.RepositoryPane.e9bd57a336', 'Worktree Location')}
        description={translate(
          'auto.components.settings.RepositoryPane.e63bb96a9b',
          'Project-specific directory for new worktrees.'
        )}
        keywords={[
          repo.displayName,
          'worktree path',
          'workspace path',
          'directory',
          'relative',
          '../worktrees'
        ]}
        className="space-y-2"
        forceVisible={forceVisible}
      >
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryPane.e9bd57a336', 'Worktree Location')}
          </Label>
          {repo.worktreeBasePath ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => updateRepo(repo.id, { worktreeBasePath: undefined })}
            >
              {translate('auto.components.settings.RepositoryPane.8ccacbeb5a', 'Use Global')}
            </Button>
          ) : null}
        </div>
        <RepoSettingsDraftInput
          repoId={repo.id}
          storeValue={repo.worktreeBasePath ?? ''}
          placeholder={settings?.workspaceDir ?? ''}
          onTextChange={() => {}}
          onBlur={(e) => {
            const worktreeBasePath = e.currentTarget.value.trim() || undefined
            // Why: even an unchanged worktreeBasePath update asks main to
            // prepare the root, which can touch the filesystem.
            if (worktreeBasePath === (repo.worktreeBasePath?.trim() || undefined)) {
              return
            }
            updateRepo(repo.id, { worktreeBasePath })
          }}
          className="h-9 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryPane.15a99d9b9f',
            'Relative paths resolve from this project root.'
          )}
        </p>
      </SearchableSetting>
    </>
  )
}
