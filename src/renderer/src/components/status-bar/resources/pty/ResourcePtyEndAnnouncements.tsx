import { useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { ResourcePtyActionStatus } from './resource-pty-action-status'
import { ptyTerminationReason } from './use-resource-pty-actions'

export function ResourcePtyEndAnnouncements({ status }: { status: ResourcePtyActionStatus }) {
  const t = useTranslate()
  const refusal = useSyncExternalStore(status.subscribe, status.getLastRefusal)
  return (
    <div role="status" className="sr-only">
      {refusal && (
        <span key={refusal.sequence}>
          {refusal.count === 1
            ? ptyTerminationReason(refusal.reason, t)
            : t('resourceManager.pty.endRefusedCount', 'Could not end {{count}} terminals.', {
                count: refusal.count,
                defaultValue_one: 'Could not end {{count}} terminal.'
              })}
        </span>
      )}
    </div>
  )
}
