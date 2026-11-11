import type { SourceControlActionLaunchPreferences } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

import {
  AgentChoiceControls,
  type AgentChoiceControlsProps
} from '../../agent/launch-settings/AgentChoiceControls'

export function SourceControlActionModelPicker(
  props: Omit<AgentChoiceControlsProps, 'value' | 'onChange'> & {
    value: SourceControlActionLaunchPreferences | undefined
    onChange: (value: SourceControlActionLaunchPreferences | undefined) => void
  }
): React.JSX.Element {
  return (
    <AgentChoiceControls
      {...props}
      value={props.value?.agentId === props.agent ? props.value : undefined}
      onChange={(value) =>
        props.onChange(
          props.agent && value && Object.keys(value).length
            ? { agentId: props.agent, ...value }
            : undefined
        )
      }
    />
  )
}
