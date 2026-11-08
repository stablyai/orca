import { Goal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatComposerModeChip } from './NativeChatComposerModeChip'

export function NativeChatComposerGoalChip(props: { onExit: () => void }): React.JSX.Element {
  const t = useTranslate()
  // Not "Clear goal": that is the banner's action on the provider's goal, and this only leaves the mode.
  return (
    <NativeChatComposerModeChip
      icon={Goal}
      label={t('components.native-chat.goal.chip', 'Goal')}
      exitLabel={t('components.native-chat.goal.exitMode', 'Exit goal mode')}
      onExit={props.onExit}
    />
  )
}
