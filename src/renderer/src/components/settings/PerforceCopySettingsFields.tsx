import { translate } from '@/i18n/i18n'
import {
  DEFAULT_PERFORCE_SETTINGS,
  type PerforceSettings
} from '../../../../shared/perforce/perforce-settings'
import { PerforceCopyRequirement } from '../perforce-copies/PerforceCopyRequirement'
import {
  NumberField,
  SettingsRow,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { TemplateField } from './perforce-settings-inputs'

/** Settings > Perforce > Workspace Copies: what a copy leaves out and the free-space floor. */
export function PerforceCopySettingsFields({
  perforce,
  update
}: {
  perforce: PerforceSettings
  update: (patch: Partial<PerforceSettings>) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="space-y-2 pt-4 pb-2">
        <SettingsSubsectionHeader
          title={translate('perforce.settings.workspace-copies.title', 'Workspace Copies')}
        />
        <PerforceCopyRequirement />
      </div>
      <NumberField
        label={translate('perforce.copies.minFreeSpace', 'Minimum free space')}
        description={translate(
          'perforce.copies.minFreeSpaceDescription',
          'Refuse to make a copy when the drive has less free space than this. A new copy takes about 1 GB, but opening it in Unity writes several GB more.'
        )}
        value={perforce.copyMinFreeSpaceGb}
        defaultValue={DEFAULT_PERFORCE_SETTINGS.copyMinFreeSpaceGb}
        min={0}
        max={4096}
        integer
        suffix="GB"
        onChange={(copyMinFreeSpaceGb) => update({ copyMinFreeSpaceGb })}
      />
      <SettingsSwitchRow
        label={translate('perforce.copies.skipPackageCache', "Leave out Unity's package cache")}
        description={translate(
          'perforce.copies.skipPackageCacheDescription',
          "Skips each Unity project's Library/PackageCache; Unity refills it on first open. On a Dev Drive copying it is cheaper and opens faster, so this is off by default."
        )}
        checked={perforce.copySkipPackageCache}
        onChange={() => update({ copySkipPackageCache: !perforce.copySkipPackageCache })}
      />
      <SettingsRow
        alignTop
        label={translate('perforce.copies.excludedFolders', 'Folders to leave out')}
        description={translate(
          'perforce.copies.excludedFoldersDescription',
          'Workspace-relative folders a copy does not take, one per line (for example a tool’s local state folder). Files Perforce tracks in them come back from the depot.'
        )}
        control={
          <TemplateField
            value={perforce.copyExcludedFolders}
            ariaLabel={translate(
              'perforce.copies.excludedFoldersAria',
              'Folders to leave out of copies'
            )}
            placeholder={translate('perforce.copies.excludedFoldersPlaceholder', '.cache')}
            onCommit={(copyExcludedFolders) => update({ copyExcludedFolders })}
          />
        }
      />
    </div>
  )
}
