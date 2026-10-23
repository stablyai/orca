import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

/**
 * The explicit ~/.ssh/config actions. `restoreRemoved` is the only path that lifts the tombstones
 * of hosts removed in Orca; a plain sync keeps them removed so bulk removal sticks.
 */
export function useSshConfigSync(onSynced: () => Promise<void>): {
  syncing: boolean
  sync: (options?: { restoreRemoved?: boolean }) => Promise<void>
} {
  const mountedRef = useMountedRef()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [syncing, setSyncing] = useState(false)

  const sync = async (options?: { restoreRemoved?: boolean }): Promise<void> => {
    setSyncing(true)
    try {
      const result = await window.api.ssh.importConfig({
        reAdopt: options?.restoreRemoved === true
      })
      useAppStore.getState().recordSshRepoReadoptions(result.repoReadoptions)
      recordFeatureInteraction('ssh')
      if (mountedRef.current) {
        if (result.targets.length === 0) {
          toast(
            translate(
              'auto.components.settings.SshPane.alreadyInSync',
              '~/.ssh/config already in sync'
            )
          )
        } else {
          toast.success(
            translate(
              result.targets.length === 1
                ? 'auto.components.settings.SshPane.syncedServerSingular'
                : 'auto.components.settings.SshPane.syncedServerPlural',
              result.targets.length === 1 ? 'Synced {{count}} server' : 'Synced {{count}} servers',
              { count: result.targets.length }
            )
          )
        }
      }
      await onSynced()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.f495689b82', 'Import failed')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSyncing(false)
      }
    }
  }

  return { syncing, sync }
}
