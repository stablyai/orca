import { Switch } from '../ui/switch'
import {
  DEFAULT_PERFORCE_SETTINGS,
  normalizePerforceSettings,
  type PerforceSettings
} from '../../../../shared/perforce/perforce-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from './SettingsFormControls'
import { PerforceAiAgentFields } from './PerforceAiFields'
import { PerforceConnectionTest } from './PerforceConnectionTest'
import { PerforceCopySettingsFields } from './PerforceCopySettingsFields'
import {
  CommitInput,
  P4_PATH_PLACEHOLDER,
  P4EnvironmentInputs,
  TemplateField
} from './perforce-settings-inputs'
import { getPerforceSettingsCatalog, type PerforceSettingId } from './perforce-search'

type PerforcePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function PerforcePane({ settings, updateSettings }: PerforcePaneProps): React.JSX.Element {
  const perforce = normalizePerforceSettings(settings.perforce)
  const update = (patch: Partial<PerforceSettings>): void => {
    void updateSettings({ perforce: { ...perforce, ...patch } })
  }
  const catalog = new Map(getPerforceSettingsCatalog().map((item) => [item.id, item]))

  const setting = (id: PerforceSettingId, body: React.ReactNode): React.JSX.Element | null => {
    const item = catalog.get(id)
    return item ? (
      <SearchableSetting
        key={id}
        title={item.title}
        description={item.description}
        keywords={item.keywords}
        className="max-w-none"
      >
        {body}
      </SearchableSetting>
    ) : null
  }
  const text = (id: PerforceSettingId): { title: string; description: string } => ({
    title: catalog.get(id)?.title ?? '',
    description: catalog.get(id)?.description ?? ''
  })
  const secondsControl = (
    value: number,
    key: 'commandTimeoutSeconds' | 'statusScanTimeoutSeconds',
    min: number,
    label: string,
    description: string
  ): React.JSX.Element => (
    <NumberField
      label={label}
      description={description}
      value={value}
      defaultValue={DEFAULT_PERFORCE_SETTINGS[key]}
      min={min}
      max={3600}
      integer
      suffix="s"
      onChange={(next) => update({ [key]: next })}
    />
  )

  return (
    <div className="space-y-4">
      {setting(
        'p4-path',
        <SettingsRow
          label={text('p4-path').title}
          description={text('p4-path').description}
          control={
            <CommitInput
              value={perforce.p4Path}
              ariaLabel={text('p4-path').title}
              placeholder={P4_PATH_PLACEHOLDER}
              className="w-72"
              onCommit={(p4Path) => update({ p4Path })}
            />
          }
        />
      )}
      {setting(
        'p4-environment',
        <SettingsRow
          alignTop
          label={text('p4-environment').title}
          description={text('p4-environment').description}
          control={
            <P4EnvironmentInputs
              values={perforce}
              onCommit={(key, next) => update({ [key]: next })}
            />
          }
        />
      )}
      {setting(
        'p4-ignore',
        <SettingsRow
          label={text('p4-ignore').title}
          description={text('p4-ignore').description}
          control={
            <div className="flex items-center gap-2">
              <CommitInput
                value={perforce.ignoreFileName}
                ariaLabel={text('p4-ignore').title}
                className="w-32"
                onCommit={(ignoreFileName) => update({ ignoreFileName })}
              />
              <Switch
                checked={perforce.useIgnoreFile}
                aria-label={text('p4-ignore').title}
                onCheckedChange={(useIgnoreFile) => update({ useIgnoreFile })}
              />
            </div>
          }
        />
      )}
      {setting(
        'timeouts',
        <div>
          {secondsControl(
            perforce.commandTimeoutSeconds,
            'commandTimeoutSeconds',
            5,
            translate('perforce.settings.timeouts.command', 'Command timeout'),
            translate(
              'perforce.settings.timeouts.commandDescription',
              'Applies to ordinary p4 commands.'
            )
          )}
          {secondsControl(
            perforce.statusScanTimeoutSeconds,
            'statusScanTimeoutSeconds',
            10,
            translate('perforce.settings.timeouts.scan', 'Workspace scan timeout'),
            translate(
              'perforce.settings.timeouts.scanDescription',
              'Applies to the reconcile scan that finds unopened changes.'
            )
          )}
        </div>
      )}
      {setting(
        'test-connection',
        <SettingsRow
          alignTop
          label={text('test-connection').title}
          description={text('test-connection').description}
          control={<PerforceConnectionTest />}
        />
      )}
      {setting(
        'group-order',
        <SettingsRow
          alignTop
          label={text('group-order').title}
          description={text('group-order').description}
          control={
            <SettingsSegmentedControl
              value={perforce.groupOrder}
              ariaLabel={text('group-order').title}
              size="sm"
              onChange={(groupOrder) => update({ groupOrder })}
              options={[
                {
                  value: 'default-first',
                  label: translate('perforce.settings.group-order.defaultFirst', 'Default first')
                },
                {
                  value: 'numbered-first',
                  label: translate('perforce.settings.group-order.numberedFirst', 'Numbered first')
                },
                {
                  value: 'unopened-first',
                  label: translate('perforce.settings.group-order.unopenedFirst', 'Unopened first')
                }
              ]}
            />
          }
        />
      )}
      {setting(
        'unopened-sections',
        <div>
          <SettingsSwitchRow
            label={translate('perforce.settings.unopened.modified', 'Show "Modified, not opened"')}
            description={translate(
              'perforce.settings.unopened.modifiedDescription',
              'Files changed or deleted on disk that are not opened for edit.'
            )}
            checked={perforce.showModifiedNotOpened}
            onChange={() => update({ showModifiedNotOpened: !perforce.showModifiedNotOpened })}
          />
          <SettingsSwitchRow
            label={translate('perforce.settings.unopened.new', 'Show "New files"')}
            description={translate(
              'perforce.settings.unopened.newDescription',
              'Files on disk that are not in the depot.'
            )}
            checked={perforce.showNewFiles}
            onChange={() => update({ showNewFiles: !perforce.showNewFiles })}
          />
        </div>
      )}
      {setting(
        'refresh-interval',
        <NumberField
          label={text('refresh-interval').title}
          description={text('refresh-interval').description}
          value={perforce.refreshIntervalSeconds}
          defaultValue={DEFAULT_PERFORCE_SETTINGS.refreshIntervalSeconds}
          min={0}
          max={3600}
          integer
          suffix="s (0 = off)"
          onChange={(next) => update({ refreshIntervalSeconds: next })}
        />
      )}
      {setting(
        'compare-against',
        <SettingsRow
          alignTop
          label={text('compare-against').title}
          description={text('compare-against').description}
          control={
            <SettingsSegmentedControl
              value={perforce.compareAgainst}
              ariaLabel={text('compare-against').title}
              size="sm"
              onChange={(compareAgainst) => update({ compareAgainst })}
              options={[
                {
                  value: 'have',
                  label: translate('perforce.settings.compare.have', 'Synced (#have)')
                },
                {
                  value: 'head',
                  label: translate('perforce.settings.compare.head', 'Depot head (#head)')
                }
              ]}
            />
          }
        />
      )}
      {setting(
        'save-read-only',
        <SettingsRow
          alignTop
          label={text('save-read-only').title}
          description={text('save-read-only').description}
          control={
            <SettingsSegmentedControl
              value={perforce.saveReadOnlyBehavior}
              ariaLabel={text('save-read-only').title}
              size="sm"
              onChange={(saveReadOnlyBehavior) => update({ saveReadOnlyBehavior })}
              options={[
                { value: 'ask', label: translate('perforce.settings.save.ask', 'Ask') },
                {
                  value: 'auto',
                  label: translate('perforce.settings.save.auto', 'Open automatically')
                },
                { value: 'never', label: translate('perforce.settings.save.never', 'Never') }
              ]}
            />
          }
        />
      )}
      {setting(
        'edited-tab-prefix',
        <SettingsSwitchRow
          label={text('edited-tab-prefix').title}
          description={text('edited-tab-prefix').description}
          checked={perforce.showEditedTabPrefix}
          onChange={() => update({ showEditedTabPrefix: !perforce.showEditedTabPrefix })}
        />
      )}
      {setting(
        'new-changelist',
        <div className="space-y-2">
          <SettingsRow
            alignTop
            label={text('new-changelist').title}
            description={text('new-changelist').description}
            control={
              <SettingsSegmentedControl
                value={perforce.newChangelistMode}
                ariaLabel={text('new-changelist').title}
                size="sm"
                onChange={(newChangelistMode) => update({ newChangelistMode })}
                options={[
                  {
                    value: 'move-selected',
                    label: translate('perforce.settings.new.moveSelected', 'Move selected files')
                  },
                  { value: 'empty', label: translate('perforce.settings.new.empty', 'Start empty') }
                ]}
              />
            }
          />
          <TemplateField
            value={perforce.newChangelistDescriptionTemplate}
            onCommit={(newChangelistDescriptionTemplate) =>
              update({ newChangelistDescriptionTemplate })
            }
          />
        </div>
      )}
      {setting(
        'submit-confirmation',
        <div>
          <SettingsSwitchRow
            label={translate('perforce.settings.submit.confirm', 'Confirm before submitting')}
            description={text('submit-confirmation').description}
            checked={perforce.confirmSubmit}
            onChange={() => update({ confirmSubmit: !perforce.confirmSubmit })}
          />
          <SettingsSwitchRow
            label={translate(
              'perforce.settings.submit.confirmShelved',
              'Confirm before submitting shelved files'
            )}
            checked={perforce.confirmShelvedOnlySubmit}
            onChange={() =>
              update({ confirmShelvedOnlySubmit: !perforce.confirmShelvedOnlySubmit })
            }
          />
        </div>
      )}
      {setting(
        'destructive-confirmation',
        <SettingsSwitchRow
          label={text('destructive-confirmation').title}
          description={text('destructive-confirmation').description}
          checked={perforce.confirmDestructiveActions}
          onChange={() =>
            update({ confirmDestructiveActions: !perforce.confirmDestructiveActions })
          }
        />
      )}
      {setting(
        'shelf-after-submit',
        <SettingsRow
          alignTop
          label={text('shelf-after-submit').title}
          description={text('shelf-after-submit').description}
          control={
            <SettingsSegmentedControl
              value={perforce.shelfAfterSubmit}
              ariaLabel={text('shelf-after-submit').title}
              size="sm"
              onChange={(shelfAfterSubmit) => update({ shelfAfterSubmit })}
              options={[
                {
                  value: 'delete',
                  label: translate('perforce.settings.shelf.delete', 'Delete shelf')
                },
                {
                  value: 'keep-copy',
                  label: translate('perforce.settings.shelf.keepCopy', 'Keep a copy')
                }
              ]}
            />
          }
        />
      )}
      {setting(
        'ai-description',
        <div>
          <SettingsSwitchRow
            label={text('ai-description').title}
            description={text('ai-description').description}
            checked={perforce.aiDescriptionEnabled}
            onChange={() => update({ aiDescriptionEnabled: !perforce.aiDescriptionEnabled })}
          />
          {perforce.aiDescriptionEnabled ? (
            <PerforceAiAgentFields perforce={perforce} update={update} />
          ) : null}
        </div>
      )}
      {setting(
        'workspace-copies',
        <PerforceCopySettingsFields perforce={perforce} update={update} />
      )}
    </div>
  )
}
