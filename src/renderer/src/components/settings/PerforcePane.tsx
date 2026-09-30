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
import { CommitInput, TemplateField } from './perforce-settings-inputs'
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
  const l = (key: string, fallback: string): string =>
    translate(`perforce.settings.${key}`, fallback)

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
              placeholder="/usr/local/bin/p4"
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
            <div className="grid w-72 gap-2">
              {(
                [
                  ['p4Port', 'P4PORT', 'ssl:perforce.example.com:1666'],
                  ['p4User', 'P4USER', 'username'],
                  ['p4Client', 'P4CLIENT', 'workspace name'],
                  ['p4Config', 'P4CONFIG', '.p4config']
                ] as const
              ).map(([key, label, placeholder]) => (
                <CommitInput
                  key={key}
                  value={perforce[key]}
                  ariaLabel={label}
                  placeholder={`${label} — ${placeholder}`}
                  onCommit={(next) => update({ [key]: next })}
                />
              ))}
            </div>
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
            l('timeouts.command', 'Command timeout'),
            l('timeouts.commandDescription', 'Applies to ordinary p4 commands.')
          )}
          {secondsControl(
            perforce.statusScanTimeoutSeconds,
            'statusScanTimeoutSeconds',
            10,
            l('timeouts.scan', 'Workspace scan timeout'),
            l(
              'timeouts.scanDescription',
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
                { value: 'default-first', label: l('group-order.defaultFirst', 'Default first') },
                {
                  value: 'numbered-first',
                  label: l('group-order.numberedFirst', 'Numbered first')
                },
                { value: 'unopened-first', label: l('group-order.unopenedFirst', 'Unopened first') }
              ]}
            />
          }
        />
      )}
      {setting(
        'unopened-sections',
        <div>
          <SettingsSwitchRow
            label={l('unopened.modified', 'Show "Modified, not opened"')}
            description={l(
              'unopened.modifiedDescription',
              'Files changed or deleted on disk that are not opened for edit.'
            )}
            checked={perforce.showModifiedNotOpened}
            onChange={() => update({ showModifiedNotOpened: !perforce.showModifiedNotOpened })}
          />
          <SettingsSwitchRow
            label={l('unopened.new', 'Show "New files"')}
            description={l('unopened.newDescription', 'Files on disk that are not in the depot.')}
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
                { value: 'have', label: l('compare.have', 'Synced (#have)') },
                { value: 'head', label: l('compare.head', 'Depot head (#head)') }
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
                { value: 'ask', label: l('save.ask', 'Ask') },
                { value: 'auto', label: l('save.auto', 'Open automatically') },
                { value: 'never', label: l('save.never', 'Never') }
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
                  { value: 'move-selected', label: l('new.moveSelected', 'Move selected files') },
                  { value: 'empty', label: l('new.empty', 'Start empty') }
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
            label={l('submit.confirm', 'Confirm before submitting')}
            description={text('submit-confirmation').description}
            checked={perforce.confirmSubmit}
            onChange={() => update({ confirmSubmit: !perforce.confirmSubmit })}
          />
          <SettingsSwitchRow
            label={l('submit.confirmShelved', 'Confirm before submitting shelved files')}
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
                { value: 'delete', label: l('shelf.delete', 'Delete shelf') },
                { value: 'keep-copy', label: l('shelf.keepCopy', 'Keep a copy') }
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
    </div>
  )
}
