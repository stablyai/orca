import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'

export type ConversationKnowledgeGraphMode = 'map' | 'graph'

export function ConversationKnowledgeGraphModeSwitch({
  value,
  onChange
}: {
  value: ConversationKnowledgeGraphMode
  onChange: (mode: ConversationKnowledgeGraphMode) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      size="xs"
      spacing={1}
      value={value}
      onValueChange={(next) => {
        if (next === 'map' || next === 'graph') {
          onChange(next)
        }
      }}
      className="h-7"
      aria-label={t('conversationKnowledge.graphMode.ariaLabel', 'Graph view')}
    >
      <ToggleGroupItem value="map">
        {t('conversationKnowledge.graphMode.map', 'Map')}
      </ToggleGroupItem>
      <ToggleGroupItem value="graph">
        {t('conversationKnowledge.graphMode.graph', 'Graph')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
