import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { useTranslate } from '@/i18n/use-translate'

type ScheduleItem = {
  id: string
  title: string
  time: string
}

export function WorkbenchSchedulePanel(): React.JSX.Element {
  const t = useTranslate()
  const [items, setItems] = useState<readonly ScheduleItem[]>([])
  const [draft, setDraft] = useState('')

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('auto.components.workbench.schedule.placeholder', 'Add a schedule item')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) {
              setItems([
                ...items,
                {
                  id: `${Date.now()}`,
                  title: draft.trim(),
                  time: new Date().toLocaleString()
                }
              ])
              setDraft('')
            }
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!draft.trim()}
          onClick={() => {
            if (!draft.trim()) {
              return
            }
            setItems([
              ...items,
              { id: `${Date.now()}`, title: draft.trim(), time: new Date().toLocaleString() }
            ])
            setDraft('')
          }}
        >
          <Plus className="size-4" />
          {t('auto.components.workbench.schedule.add', 'Add')}
        </Button>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-sleek">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate">{item.title}</span>
              <span className="block text-3xs text-muted-foreground">{item.time}</span>
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setItems(items.filter((entry) => entry.id !== item.id))}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
