import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentKanbanLaneNameInput } from './AgentKanbanLaneNameInput'

/** Trailing board slot that creates a custom lane. */
export function AgentKanbanAddLane({
  onAddLane
}: {
  onAddLane: (label: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className="flex w-[220px] shrink-0 items-start rounded-xl border border-dashed border-border/60 p-2">
        <AgentKanbanLaneNameInput
          placeholder={translate('dashboardPopout.lane.placeholder', 'e.g. Waiting')}
          ariaLabel={translate('dashboardPopout.lane.nameLabel', 'New lane name')}
          onCommit={(label) => {
            setEditing(false)
            onAddLane(label)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={translate('dashboardPopout.lane.add', 'Add lane')}
      title={translate('dashboardPopout.lane.add', 'Add lane')}
      className="flex w-9 shrink-0 items-start justify-center rounded-xl border border-dashed border-border/60 pt-2.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <PlusIcon className="size-3.5" />
    </button>
  )
}
