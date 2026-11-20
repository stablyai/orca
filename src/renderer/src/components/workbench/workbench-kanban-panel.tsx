import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { useTranslate } from '@/i18n/use-translate'

type ColumnId = 'todo' | 'doing' | 'review' | 'done'

type KanbanCard = {
  id: string
  title: string
  tag: string
}

const COLUMNS: readonly ColumnId[] = ['todo', 'doing', 'review', 'done']

const INITIAL: Record<ColumnId, readonly KanbanCard[]> = {
  todo: [{ id: 'issue-1', title: 'Issue triage queue', tag: 'bug' }],
  doing: [{ id: 'issue-2', title: 'Auto fix in progress', tag: 'bug' }],
  review: [{ id: 'issue-3', title: 'open-code-review', tag: 'review' }],
  done: []
}

export function WorkbenchKanbanPanel(): React.JSX.Element {
  const t = useTranslate()
  const [columns, setColumns] = useState(INITIAL)

  function move(cardId: string, from: ColumnId, direction: -1 | 1): void {
    const fromIndex = COLUMNS.indexOf(from)
    const to = COLUMNS[fromIndex + direction]
    if (!to) {
      return
    }
    const card = columns[from].find((entry) => entry.id === cardId)
    if (!card) {
      return
    }
    setColumns({
      ...columns,
      [from]: columns[from].filter((entry) => entry.id !== cardId),
      [to]: [...columns[to], card]
    })
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto xl:grid-cols-4 scrollbar-sleek">
      {COLUMNS.map((column) => (
        <Card key={column} className="flex min-h-0 flex-col gap-2 p-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t(`auto.components.workbench.kanban.${column}`, column)}
          </span>
          {columns[column].map((card) => (
            <div key={card.id} className="rounded-md border p-2 text-sm">
              <span className="block truncate">{card.title}</span>
              <span className="mt-1 flex items-center justify-between">
                <Badge variant="secondary" className="rounded-full">
                  {card.tag}
                </Badge>
                <span className="flex gap-1">
                  <Button variant="ghost" size="xs" onClick={() => move(card.id, column, -1)}>
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => move(card.id, column, 1)}>
                    <ChevronRight className="size-4" />
                  </Button>
                </span>
              </span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  )
}
