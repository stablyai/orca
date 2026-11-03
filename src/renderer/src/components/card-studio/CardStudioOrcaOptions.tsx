import React from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  AGENT_ACTIVITY_DISPLAY_OPTIONS,
  CARD_LAYOUT_OPTIONS,
  PROPERTY_OPTIONS
} from '../sidebar/sidebar-workspace-option-items'
import { useToggleCardProperty } from '../sidebar/worktree-card-option-items'
import { CardStudioSection } from './CardStudioSection'

function Choices<Id extends string>({
  name,
  value,
  options,
  onChange
}: {
  name: string
  value: Id
  options: readonly { id: Id; readonly label: string }[]
  onChange: (id: Id) => void
}): React.JSX.Element {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.id === next)
        if (option) {
          onChange(option.id)
        }
      }}
    >
      {options.map((option) => (
        <div key={option.id} className="flex items-center gap-2">
          <RadioGroupItem id={`${name}-${option.id}`} value={option.id} />
          <Label htmlFor={`${name}-${option.id}`}>{option.label}</Label>
        </div>
      ))}
    </RadioGroup>
  )
}

/** Orca's card options: the same settings the sidebar's options menu edits, and paired phones read. */
export function CardStudioOrcaOptions(): React.JSX.Element {
  const compact = useAppStore((s) => s.settings?.compactWorktreeCards === true)
  const setWorktreeCardMode = useAppStore((s) => s.setWorktreeCardMode)
  const agentRows = useAppStore((s) => s.agentActivityDisplayMode)
  const setAgentRows = useAppStore((s) => s.setAgentActivityDisplayMode)
  const properties = useAppStore((s) => s.worktreeCardProperties)
  const toggleProperty = useToggleCardProperty()
  return (
    <>
      <CardStudioSection title={translate('auto.components.cardStudio.layout', 'Layout')}>
        <Choices
          name="card-layout"
          value={compact ? 'compact' : 'detailed'}
          options={CARD_LAYOUT_OPTIONS}
          onChange={(id) => setWorktreeCardMode(id === 'compact' ? 'Compact' : 'Default')}
        />
      </CardStudioSection>
      <CardStudioSection title={translate('auto.components.cardStudio.agents', 'Agent rows')}>
        <Choices
          name="agent-rows"
          value={agentRows === 'compact' ? 'compact' : 'full'}
          options={AGENT_ACTIVITY_DISPLAY_OPTIONS}
          onChange={setAgentRows}
        />
      </CardStudioSection>
      <CardStudioSection title={translate('auto.components.cardStudio.properties', 'Show')}>
        <div className="flex flex-col gap-2">
          {PROPERTY_OPTIONS.map((option) => (
            <div key={option.id} className="flex items-center justify-between gap-3">
              <Label htmlFor={`card-property-${option.id}`}>{option.label}</Label>
              <Switch
                id={`card-property-${option.id}`}
                checked={properties.includes(option.id)}
                onCheckedChange={(checked) => toggleProperty(option.id, checked)}
              />
            </div>
          ))}
        </div>
      </CardStudioSection>
    </>
  )
}
