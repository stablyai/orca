import React from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginSidebarCards } from '@/store/plugin-sidebar-cards'

const ORCA_CARD = 'orca'

/** Which card draws workspaces: Orca's own, or one an installed plugin adds. */
export function CardStudioCardPicker(): React.JSX.Element {
  const cards = usePluginSidebarCards()
  const selected = useAppStore((s) => s.settings?.workspaceCardId ?? ORCA_CARD)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const value = cards.some((card) => card.id === selected) ? selected : ORCA_CARD
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) =>
        void updateSettings({ workspaceCardId: next === ORCA_CARD ? undefined : next })
      }
    >
      <CardChoice
        id={ORCA_CARD}
        title={translate('auto.components.cardStudio.orcaCard', "Orca's card")}
        description={translate(
          'auto.components.cardStudio.orcaCardDescription',
          'The built-in card, with the layout and properties below.'
        )}
      />
      {cards.map((card) => (
        <CardChoice
          key={card.id}
          id={card.id}
          title={card.label}
          description={card.description ?? card.pluginName}
        />
      ))}
    </RadioGroup>
  )
}

function CardChoice({
  id,
  title,
  description
}: {
  id: string
  title: string
  description: string
}): React.JSX.Element {
  const inputId = `card-studio-choice-${id}`
  return (
    <div className="flex items-start gap-2.5">
      <RadioGroupItem id={inputId} value={id} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={inputId}>{title}</Label>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
    </div>
  )
}
