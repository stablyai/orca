import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type RepositorySpotlightSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Pick<Repo, 'spotlightTestingEnabled'>>) => void
  forceVisible: boolean
}

export function RepositorySpotlightSection({
  repo,
  updateRepo,
  forceVisible
}: RepositorySpotlightSectionProps): React.JSX.Element {
  const enabled = repo.spotlightTestingEnabled === true
  const spotlightActive = useAppStore((s) => Boolean(s.spotlightByRepo?.[repo.id]))
  const deactivateSpotlight = useAppStore((s) => s.deactivateSpotlight)
  const handleToggle = (): void => {
    // Turning the feature off while it's live must first restore the root —
    // otherwise the root stays mirrored while the holder row's controls vanish.
    // Only flip the flag once the restore succeeds so a restore-conflict keeps
    // the controls visible for a retry.
    if (enabled && spotlightActive) {
      void deactivateSpotlight(repo.id).then((result) => {
        if (result.ok) {
          updateRepo(repo.id, { spotlightTestingEnabled: false })
        }
      })
      return
    }
    updateRepo(repo.id, { spotlightTestingEnabled: !enabled })
  }
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositorySpotlightSection.title',
            'Spotlight Testing'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositorySpotlightSection.sectionDescription',
            'Test workspace changes against the project root without duplicating installed dependencies or build output.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositorySpotlightSection.logsDescription',
            "While Spotlight is on, the server terminal's output is mirrored to .orca/spotlight.log so agents in any workspace can read it (env var ORCA_SPOTLIGHT_LOG)."
          )}
        </p>
      </div>
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositorySpotlightSection.title',
          'Spotlight Testing'
        )}
        description={translate(
          'auto.components.settings.RepositorySpotlightSection.toggleDescription',
          'Show a Spotlight button on workspaces of this project that mirrors their tracked changes onto the project root.'
        )}
        keywords={[repo.displayName, 'spotlight', 'testing', 'sync', 'repo root']}
        className="space-y-2"
        forceVisible={forceVisible}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.RepositorySpotlightSection.toggleLabel',
            'Use Spotlight testing'
          )}
          description={translate(
            'auto.components.settings.RepositorySpotlightSection.toggleDescription',
            'Show a Spotlight button on workspaces of this project that mirrors their tracked changes onto the project root.'
          )}
          checked={enabled}
          onChange={handleToggle}
        />
      </SearchableSetting>
    </section>
  )
}
