import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function StructuredAgentSessionTerminalReturnButton(props: {
  enabled: boolean
  onReturn?: () => void
}): React.JSX.Element | null {
  if (!props.enabled) {
    return null
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="pane-title-split-trigger"
      onClick={(event) => {
        event.stopPropagation()
        props.onReturn?.()
      }}
    >
      {translate('components.native-chat.handoff.returnToChat', 'Return to chat')}
    </Button>
  )
}
