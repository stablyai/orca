import React from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { BoardColumnModel } from '@/components/task-page-azure-devops-board-layout'

/** One grid track: a whole column, or one half of a split column. */
export type BoardSlot = { model: BoardColumnModel; done: boolean; track: number }

export function buildBoardSlots(columns: BoardColumnModel[]): BoardSlot[] {
  const slots: BoardSlot[] = []
  let track = 1
  for (const model of columns) {
    for (const done of model.column.isSplit ? [false, true] : [false]) {
      slots.push({ model, done, track })
      track += 1
    }
  }
  return slots
}

const HEADER_CELL_CLASS =
  'flex h-9 min-w-0 items-center gap-2 border-b border-l border-border/50 bg-background px-2'

function WipCounter({ model }: { model: BoardColumnModel }): React.JSX.Element | null {
  if (model.limit === null) {
    return null
  }
  const locale = getIntlLocale()
  return (
    <span
      data-board-wip
      data-over-limit={model.overLimit ? 'true' : 'false'}
      className={cn(
        'shrink-0 text-xs tabular-nums',
        model.overLimit ? 'text-destructive' : 'text-status-success'
      )}
      title={translate(
        'auto.components.TaskPage.azureDevOps.board.wipLimit',
        'Work in progress limit'
      )}
    >
      {`${model.count.toLocaleString(locale)} / ${model.limit.toLocaleString(locale)}`}
    </span>
  )
}

export function AzureDevOpsBoardColumnHeaders({
  slots,
  showSubHeaders
}: {
  slots: BoardSlot[]
  showSubHeaders: boolean
}): React.JSX.Element {
  const doingSlots = slots.filter((slot) => !slot.done)
  return (
    <>
      {doingSlots.map((slot) => (
        <div
          key={slot.model.column.id}
          data-board-column={slot.model.column.id}
          className={cn(HEADER_CELL_CLASS, 'sticky top-0 z-20')}
          style={{
            gridColumn: `${slot.track} / span ${slot.model.column.isSplit ? 2 : 1}`,
            gridRow: 1
          }}
          title={slot.model.column.description ?? undefined}
        >
          <span
            data-board-column-name
            className="min-w-0 truncate text-xs font-medium uppercase tracking-wide"
          >
            {slot.model.column.name}
          </span>
          <WipCounter model={slot.model} />
        </div>
      ))}
      {showSubHeaders
        ? slots.map((slot) =>
            slot.model.column.isSplit ? (
              <div
                key={`${slot.model.column.id}-${slot.done}`}
                data-board-subcolumn={`${slot.model.column.id}|${slot.done ? 'done' : 'doing'}`}
                className={cn(
                  HEADER_CELL_CLASS,
                  'h-7 text-2xs uppercase tracking-wide text-muted-foreground sticky top-9 z-10'
                )}
                style={{ gridColumn: slot.track, gridRow: 2 }}
              >
                {slot.done
                  ? translate('auto.components.TaskPage.azureDevOps.board.done', 'Done')
                  : translate('auto.components.TaskPage.azureDevOps.board.doing', 'Doing')}
              </div>
            ) : (
              <div
                key={slot.model.column.id}
                className={cn(HEADER_CELL_CLASS, 'h-7 sticky top-9 z-10')}
                style={{ gridColumn: slot.track, gridRow: 2 }}
              />
            )
          )
        : null}
    </>
  )
}
