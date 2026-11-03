import React from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginWorkspaceLists } from '@/store/plugin-workspace-lists'
import { pickWorkspaceList } from '../plugins/page/PluginWorkspaceListUseButton'
import { CardStudioSection } from './CardStudioSection'

const ORCA_LIST = 'orca'

/** How the sidebar arranges workspaces: Orca's Group by and Sort by, or a plugin's sections. */
export function CardStudioListPicker(): React.JSX.Element | null {
  const lists = usePluginWorkspaceLists()
  const selected = useAppStore((s) => s.settings?.workspaceListId ?? ORCA_LIST)
  if (lists.length === 0) {
    return null
  }
  const value = lists.some((list) => list.id === selected) ? selected : ORCA_LIST
  return (
    <CardStudioSection title={translate('auto.components.cardStudio.list', 'List')}>
      <RadioGroup
        value={value}
        onValueChange={(next) => pickWorkspaceList(next === ORCA_LIST ? null : next, lists)}
      >
        {[
          {
            id: ORCA_LIST,
            title: translate('auto.components.cardStudio.orcaList', "Orca's grouping"),
            description: translate(
              'auto.components.cardStudio.orcaListDescription',
              'Group by and Sort by from the sidebar options.'
            )
          },
          ...lists.map((list) => ({
            id: list.id,
            title: list.label,
            description: list.description ?? list.pluginName
          }))
        ].map((choice) => (
          <div key={choice.id} className="flex items-start gap-2.5">
            <RadioGroupItem
              id={`card-studio-list-${choice.id}`}
              value={choice.id}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={`card-studio-list-${choice.id}`}>{choice.title}</Label>
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            </div>
          </div>
        ))}
      </RadioGroup>
    </CardStudioSection>
  )
}
