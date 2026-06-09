import type { GlobalSettings, SourceControlGroupOrder } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type SourceControlGroupOrderSettingProps = {
  settings: Pick<GlobalSettings, 'sourceControlGroupOrder'>
  updateSettings: (updates: Pick<GlobalSettings, 'sourceControlGroupOrder'>) => void | Promise<void>
}

const SOURCE_CONTROL_GROUP_ORDER_OPTIONS: readonly {
  value: SourceControlGroupOrder
}[] = [{ value: 'changes-first' }, { value: 'staged-first' }, { value: 'untracked-first' }]

export function SourceControlGroupOrderSetting({
  settings,
  updateSettings
}: SourceControlGroupOrderSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate('auto.components.settings.GitPane.4a2e56adf0', 'Source Control Group Order')}
      description={translate(
        'auto.components.settings.GitPane.11a09a67bf',
        'Choose how uncommitted file groups are ordered.'
      )}
      keywords={['source control', 'staged', 'changes', 'untracked', 'group order', 'commit']}
      className="space-y-3"
    >
      <div className="space-y-0.5">
        <Label>
          {translate('auto.components.settings.GitPane.4a2e56adf0', 'Source Control Group Order')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GitPane.486b2963d2',
            'Choose how uncommitted file groups are ordered. Conflicts stay pinned at the top.'
          )}
        </p>
      </div>
      <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
        {SOURCE_CONTROL_GROUP_ORDER_OPTIONS.map((option) => {
          const isActive = settings.sourceControlGroupOrder === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                if (!isActive) {
                  updateSettings({ sourceControlGroupOrder: option.value })
                }
              }}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                isActive
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.value === 'changes-first'
                ? translate('auto.components.settings.GitPane.8d3f1277e7', 'Changes First')
                : option.value === 'staged-first'
                  ? translate('auto.components.settings.GitPane.b4a911d698', 'Staged First')
                  : translate('auto.components.settings.GitPane.52aa7b5c96', 'Untracked First')}
            </button>
          )
        })}
      </div>
    </SearchableSetting>
  )
}
