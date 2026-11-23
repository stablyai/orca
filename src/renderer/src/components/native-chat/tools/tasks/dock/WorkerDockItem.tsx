import { useTranslate } from '@/i18n/use-translate'
import { workerDockNeedsAttention } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'
import { cn } from '@/lib/class-names'

export function WorkerDockItem({
  index,
  identity,
  row,
  small,
  start,
  measure,
  narrow,
  compact,
  mixed,
  modelColumn,
  visible,
  pending,
  orderHeld,
  onOpen,
  onAction
}: {
  index: number
  identity: { id: string; state: WorkerDockRowView['state']; heading: boolean; lead: boolean }
  row: WorkerDockRowView | undefined
  small: boolean
  start: number
  measure: (element: HTMLDivElement | null) => void
  narrow: boolean
  compact?: boolean
  mixed: boolean
  modelColumn: boolean
  visible: boolean
  pending: boolean
  orderHeld: boolean
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
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
        <div
          className={cn(
            'flex h-6 items-center justify-between bg-muted px-4 text-2xs text-muted-foreground',
            narrow ? 'pr-11' : 'pr-14'
          )}
        >
          <h3 className="font-medium">
            {workerDockNeedsAttention(identity.state)
              ? t('components.native-chat.workerDock.attention', 'Needs attention')
              : t('components.native-chat.workerDock.openWork', 'Open work')}
            {orderHeld
              ? ` · ${t('components.native-chat.workerDock.orderHeld', 'Order held')}`
              : ''}
          </h3>
          {index === 0 ? (
            <span>{t('components.native-chat.workerDock.statusChanged', 'Status changed')}</span>
          ) : null}
        </div>
      ) : null}
      {row ? (
        <WorkerDockRow
          row={row}
          narrow={narrow}
          compact={compact}
          lead={identity.lead}
          mixed={mixed}
          modelColumn={modelColumn}
          visible={visible}
          pending={pending}
          onOpen={onOpen}
          onAction={onAction}
        />
      ) : (
        <div className="min-h-10 px-4 py-2">
          {t('components.native-chat.workerDock.loadingWorker', 'Loading worker…')}
        </div>
      )}
    </div>
  )
}
