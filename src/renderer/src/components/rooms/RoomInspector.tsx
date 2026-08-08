import { useState } from 'react'
import { Pin, Users } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RoomData } from './use-room-data'
import { PeoplePanel } from './RoomPeoplePanel'
import { PinsPanel } from './RoomPinsPanel'

type Tab = 'people' | 'pins'

const TABS: { id: Tab; copy: [string, string]; icon: typeof Users }[] = [
  { id: 'people', copy: ['rooms.inspector.people', 'People'], icon: Users },
  { id: 'pins', copy: ['rooms.inspector.pins', 'Pins'], icon: Pin }
]

export function RoomInspector({
  data,
  onAddAgent
}: {
  data: RoomData
  onAddAgent: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('people')
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-muted/10">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        {TABS.map((item) => {
          const Icon = item.icon
          const label = translate(...item.copy)
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setTab(item.id)}
                  aria-label={label}
                  aria-current={tab === item.id ? 'page' : undefined}
                  className={cn(
                    'flex h-7 flex-1 items-center justify-center rounded-md border border-transparent text-muted-foreground',
                    tab === item.id
                      ? 'border-border bg-accent text-foreground'
                      : 'hover:border-border hover:text-foreground'
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <fieldset
        disabled={Boolean(data.snapshot?.room.archivedAt)}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto border-0 p-3 scrollbar-sleek"
      >
        {tab === 'people' ? <PeoplePanel data={data} onAddAgent={onAddAgent} /> : null}
        {tab === 'pins' ? <PinsPanel data={data} /> : null}
      </fieldset>
    </aside>
  )
}
