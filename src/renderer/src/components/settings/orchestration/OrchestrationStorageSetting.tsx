import { useEffect, useState } from 'react'
import { HardDrive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatBytes } from '../../../../../shared/format-bytes'
import type { OrchestrationDbStorage } from '../../../../../shared/orchestration/orchestration-db-storage'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { getOrchestrationStorageTitle } from './orchestration-storage-copy'

// A file not created yet will shrink itself.
const NO_DATABASE: OrchestrationDbStorage = {
  databaseBytes: 0,
  reclaimableBytes: 0,
  shrinksItself: true
}

function describeStorage(storage: OrchestrationDbStorage, t: Translate): string {
  const size = formatBytes(storage.databaseBytes)
  return storage.shrinksItself
    ? t(
        'auto.components.settings.OrchestrationPane.storageShrinksItself',
        'Uses {{size}} on this computer. Orca returns space it no longer needs to the disk on its own.',
        { size }
      )
    : t(
        'auto.components.settings.OrchestrationPane.storageReclaimable',
        'Uses {{size}} on this computer, {{reclaimable}} of it unused. Reclaim space returns the unused part to the disk, and Orca keeps doing so on its own afterwards.',
        { size, reclaimable: formatBytes(storage.reclaimableBytes) }
      )
}

export function OrchestrationStorageSetting(): React.JSX.Element | null {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const mounted = useMountedRef()
  // Undefined while loading, so the row holds its place instead of appearing later.
  const [storage, setStorage] = useState<OrchestrationDbStorage | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { getOrchestrationStorage, relaunchReclaimingOrchestrationStorage } = window.api.app

  useEffect(() => {
    let cancelled = false
    const read = getOrchestrationStorage
      ? getOrchestrationStorage().then((next) => next ?? NO_DATABASE)
      : Promise.resolve(null)
    void read
      .catch(() => null)
      .then((next) => {
        if (!cancelled) {
          setStorage(next)
        }
      })
    return () => {
      cancelled = true
    }
  }, [getOrchestrationStorage])

  async function reclaim(): Promise<void> {
    if (!relaunchReclaimingOrchestrationStorage) {
      return
    }
    setError(null)
    const accepted = await confirm({
      title: t(
        'auto.components.settings.OrchestrationPane.storageReclaimTitle',
        'Restart Orca to reclaim space?'
      ),
      description: t(
        'auto.components.settings.OrchestrationPane.storageReclaimWarning',
        'Orca closes, rewrites its orchestration database, then opens again. On a large database it stays closed for a minute or more, and agents that use orchestration wait until it is back. Runs, tasks and messages are kept.'
      ),
      confirmLabel: t(
        'auto.components.settings.OrchestrationPane.storageReclaimConfirm',
        'Restart and reclaim'
      )
    })
    if (!accepted || !mounted.current) {
      return
    }
    setBusy(true)
    try {
      const request = await relaunchReclaimingOrchestrationStorage()
      if (!request.ok && mounted.current) {
        setBusy(false)
        setError(
          t(
            'auto.components.settings.OrchestrationPane.storageReclaimDiskSpace',
            'Reclaiming needs {{needed}} of free disk space, and {{free}} is free. Free up disk space, then try again.',
            { needed: formatBytes(request.neededBytes), free: formatBytes(request.freeBytes) }
          )
        )
      }
    } catch {
      if (mounted.current) {
        setBusy(false)
        setError(
          t(
            'auto.components.settings.OrchestrationPane.storageReclaimError',
            'Could not restart Orca to reclaim space. Try again.'
          )
        )
      }
    }
  }

  if (storage === null) {
    return null
  }
  return (
    <div>
      <SettingsRow
        label={getOrchestrationStorageTitle(t)}
        description={storage ? describeStorage(storage, t) : ' '}
        control={
          !storage || storage.shrinksItself ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void reclaim()}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <HardDrive className="size-3.5" />
              )}
              {t('auto.components.settings.OrchestrationPane.storageReclaim', 'Reclaim space')}
            </Button>
          )
        }
      />
      {(error ?? storage?.lastReclaimFailed) ? (
        <p className="pb-3 text-xs text-destructive">
          {error ??
            t(
              'auto.components.settings.OrchestrationPane.storageReclaimFailed',
              'The last reclaim could not finish, so the database was left as it was. Free up disk space, then try again.'
            )}
        </p>
      ) : null}
    </div>
  )
}
