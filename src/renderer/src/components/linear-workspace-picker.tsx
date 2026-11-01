import type { LinearWorkspace } from '../../../shared/linear/workspace-types'
import { translate } from '@/i18n/i18n'
import { WorkItemScopePicker } from './work-item-scope-picker'

export function LinearWorkspacePicker({
  workspaces,
  value,
  onChange,
  disabled
}: {
  workspaces: readonly LinearWorkspace[]
  value: string | null | undefined
  onChange: (workspaceId: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const selected = workspaces.find((workspace) => workspace.id === value)
  return (
    <WorkItemScopePicker
      options={workspaces.map((workspace) => ({
        key: workspace.id,
        value: workspace.id,
        label: workspace.organizationName,
        searchText: `${workspace.organizationName} ${workspace.displayName} ${workspace.id}`
      }))}
      selectedKey={value === 'all' ? null : (value ?? null)}
      selectedLabel={
        value && value !== 'all'
          ? (selected?.organizationName ??
            translate(
              'components.linearWorkspacePicker.unavailable',
              'Unavailable Linear workspace'
            ))
          : undefined
      }
      onChange={(workspaceId) => onChange(workspaceId ?? 'all')}
      label={translate('components.linearWorkspacePicker.label', 'Linear workspace')}
      allLabel={translate('components.linearWorkspacePicker.all', 'All Linear workspaces')}
      searchPlaceholder={translate(
        'components.linearWorkspacePicker.search',
        'Search Linear workspaces'
      )}
      emptyLabel={translate('components.linearWorkspacePicker.empty', 'No workspaces found.')}
      disabled={disabled}
    />
  )
}
