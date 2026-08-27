import React from 'react'
import { SquareKanban } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { TaskProvider } from '../../../../../shared/task-providers'

export type KanbanConnectEmptyProps = {
  onConnect: () => void
  onHide: (provider: TaskProvider, label: string) => void
}

export function KanbanConnectEmpty({
  onConnect,
  onHide
}: KanbanConnectEmptyProps): React.JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
      <SquareKanban className="mb-4 size-8 text-muted-foreground/60" />
      <p className="text-base font-medium text-foreground">
        {translate('auto.components.kanban.connect.title', 'Connect your Kanban')}
      </p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {translate(
          'auto.components.kanban.connect.description',
          'Browse and start work from your Kanban tasks on https://kanban.fpimi.ru.'
        )}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onConnect}>
          {translate('auto.components.kanban.connect.action', 'Connect Kanban')}
        </Button>
        <Button variant="outline" onClick={() => onHide('kanban', 'Kanban')}>
          {translate('auto.components.kanban.connect.hide', 'Hide Kanban')}
        </Button>
      </div>
    </div>
  )
}
