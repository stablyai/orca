import { Goal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { NativeChatComposerModeChip } from './NativeChatComposerModeChip'

export function NativeChatComposerGoalChip(props: { onExit: () => void }): React.JSX.Element {
  // Not "Clear goal": that is the banner's action on the provider's goal, and this only leaves the mode.
  return (
    <NativeChatComposerModeChip
      icon={Goal}
      label={translate('components.native-chat.goal.chip', 'Goal')}
      exitLabel={translate('components.native-chat.goal.exitMode', 'Exit goal mode')}
      onExit={props.onExit}
    />
  )
}
