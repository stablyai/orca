import { workerDockNeedsAttention } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'

export function WorkerDockItem({
  index,
  identity,
  row,
  retired,
  small,
  start,
  measure,
  narrow,
  mixed,
  modelColumn,
  visible,
  pending,
  orderHeld,
  onOpen,
  onAction
}: {
  index: number
  identity: { id: string; state: WorkerDockRowView['state']; heading: boolean }
  row: WorkerDockRowView | undefined
  retired: boolean
  small: boolean
  start: number
  measure: (element: HTMLDivElement | null) => void
  narrow: boolean
  mixed: boolean
  modelColumn: boolean
  visible: boolean
  pending: boolean
  orderHeld: boolean
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  return (
    <div
      data-index={index}
      ref={small ? undefined : measure}
      style={{
        position: small ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: small ? undefined : `translateY(${start}px)`
      }}
    >
      {identity.heading ? (
        <div className="flex h-6 items-center justify-between bg-muted px-4 text-2xs">
          <h3 className="font-medium">
            {workerDockNeedsAttention(identity.state) ? 'Needs attention' : 'Open work'}
            {orderHeld ? ' · Order held' : ''}
          </h3>
          {index === 0 ? <span>Status changed</span> : null}
        </div>
      ) : null}
      {row ? (
        <WorkerDockRow
          row={retired ? { ...row, retired: true } : row}
          narrow={narrow}
          mixed={mixed}
          modelColumn={modelColumn}
          visible={visible}
          pending={pending}
          onOpen={onOpen}
          onAction={onAction}
        />
      ) : (
        <div className="min-h-10 px-4 py-2">Loading worker…</div>
      )}
    </div>
  )
}
