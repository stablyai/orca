import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'

export type ConversationKnowledgeGraphMode = 'map' | 'graph'

export function ConversationKnowledgeGraphModeSwitch({
  value,
  onChange
}: {
  value: ConversationKnowledgeGraphMode
  onChange: (mode: ConversationKnowledgeGraphMode) => void
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      variant="compact"
      size="xs"
      spacing={1}
      value={value}
      onValueChange={(next) => {
        if (next === 'map' || next === 'graph') {
          onChange(next)
        }
      }}
      className="h-7"
      aria-label={translate('conversationKnowledge.graphMode.ariaLabel', 'Graph view')}
    >
      <ToggleGroupItem value="map">
        {translate('conversationKnowledge.graphMode.map', 'Map')}
      </ToggleGroupItem>
      <ToggleGroupItem value="graph">
        {translate('conversationKnowledge.graphMode.graph', 'Graph')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
