import { NativeChatSessionOptionRows } from '../../native-chat/session/options/controls/NativeChatSessionOptionRows'
import type { AgentPickerEdit } from '../../../../../shared/agent-launch/picker/agent-launch-picker-edits'

/** The card's inline option row (effort, speed) above its launch buttons. */
export function AgentLaunchOptionRows({
  rows,
  model,
  textGeneration,
  onEdit
}: {
  rows: React.ComponentProps<typeof NativeChatSessionOptionRows>['options']
  model: string | undefined
  /** A text action's own Arguments own these values, so the row never sets one as an option. */
  textGeneration?: boolean
  onEdit: (edit: AgentPickerEdit) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-9 min-w-0 shrink-0 items-center border-t border-border px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <NativeChatSessionOptionRows
          options={rows}
          shownReason={null}
          pendingIds={new Set()}
          divided={false}
          layout="inline"
          onSet={(option, value) => {
            if (textGeneration && value === 'arguments') {
              return
            }
            onEdit(
              option.id === 'fastMode' || option.id === 'serviceTier'
                ? { kind: 'speed', key: option.id, value: String(value), model }
                : { kind: 'choice', patch: { options: { [option.id]: String(value) } } }
            )
          }}
          onAction={() => {}}
        />
      </div>
    </div>
  )
}
