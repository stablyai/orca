import type { GlobalSettings, Repo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { BaseRefPicker } from './BaseRefPicker'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type RepositoryWorktreeDefaultsUpdate = Pick<Repo, 'worktreeBasePath' | 'worktreeBaseRef'>

type RepositoryWorktreeDefaultsSectionProps = {
  repo: Repo
  settings: Pick<GlobalSettings, 'workspaceDir'> | null
  updateRepo: (repoId: string, updates: Partial<RepositoryWorktreeDefaultsUpdate>) => void
  forceVisible: boolean
}

export function RepositoryWorktreeDefaultsSection({
  repo,
  settings,
  updateRepo,
  forceVisible
}: RepositoryWorktreeDefaultsSectionProps): React.JSX.Element {
  return (
    <>
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
