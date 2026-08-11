import type { MutableRefObject } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { removeSshTargetWithBestEffortCleanup } from './ssh-target-remove'
import { terminateSshSessionsWithReconnect } from './ssh-session-termination'
import { formatSshErrorOrFallback, formatSshUserFacingError } from './ssh-user-facing-error'

type MountedRef = MutableRefObject<boolean>

// Why: a target-list refresh failure after a successful action must not surface
// as the action's own error toast (e.g. "Failed to remove target").
async function refreshSshTargetsBestEffort(
  loadTargets: () => Promise<void>,
  mountedRef: MountedRef
): Promise<void> {
  try {
    await loadTargets()
  } catch {
    if (mountedRef.current) {
      toast.error(
        translate(
          'auto.components.settings.ssh.pane.host.actions.7a266605eb',
          'Could not refresh SSH targets'
        )
      )
    }
  }
}

export async function removeSshPaneTarget(args: {
  id: string
  mountedRef: MountedRef
  clearRemovedSshTargetState: (id: string) => void
  loadTargets: () => Promise<void>
}): Promise<void> {
  try {
    await removeSshTargetWithBestEffortCleanup(window.api.ssh, args.id)
    // Why: a deleted passphrase-gated target may still have deferred
    // reconnect metadata; clear it so focused SSH tabs stop retrying it.
    args.clearRemovedSshTargetState(args.id)
    if (args.mountedRef.current) {
      toast.success(translate('auto.components.settings.SshPane.a0237eb1ca', 'Target removed'))
    }
  } catch (err) {
    if (args.mountedRef.current) {
      toast.error(
        formatSshErrorOrFallback(
          err,
          translate('auto.components.settings.SshPane.c2a69510e3', 'Failed to remove target')
        )
      )
    }
    return
  }
  await refreshSshTargetsBestEffort(args.loadTargets, args.mountedRef)
}

export async function connectSshPaneTarget(
  targetId: string,
  recordFeatureInteraction: (feature: 'ssh') => void | Promise<void>
): Promise<void> {
  try {
    await window.api.ssh.connect({ targetId })
    await recordFeatureInteraction('ssh')
  } catch (err) {
    toast.error(
      formatSshErrorOrFallback(
        err,
        translate('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
      )
    )
  }
}

export async function disconnectSshPaneTarget(
  targetId: string,
  recordFeatureInteraction: (feature: 'ssh') => void | Promise<void>
): Promise<void> {
  try {
    await window.api.ssh.disconnect({ targetId })
    await recordFeatureInteraction('ssh')
  } catch (err) {
    toast.error(
      formatSshErrorOrFallback(
        err,
        translate('auto.components.settings.SshPane.a43de1d3ee', 'Disconnect failed')
      )
    )
  }
}

export async function terminateSshPaneSessions(targetId: string): Promise<void> {
  try {
    await terminateSshSessionsWithReconnect(targetId)
    toast.success(
      translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
    )
  } catch (err) {
    toast.error(
      formatSshErrorOrFallback(
        err,
        translate('auto.components.settings.SshPane.025e107643', 'Failed to end remote terminals')
      )
    )
  }
}

export async function resetSshPaneRelay(args: {
  targetId: string
  mountedRef: MountedRef
  loadTargets: () => Promise<void>
}): Promise<void> {
  try {
    await window.api.ssh.resetRelay({ targetId: args.targetId })
    if (args.mountedRef.current) {
      toast.success(translate('auto.components.settings.SshPane.db2e48975e', 'Remote relay reset'))
    }
  } catch (err) {
    if (args.mountedRef.current) {
      toast.error(
        formatSshErrorOrFallback(
          err,
          translate('auto.components.settings.SshPane.2c4ee7332b', 'Failed to reset remote relay')
        )
      )
    }
    return
  }
  await refreshSshTargetsBestEffort(args.loadTargets, args.mountedRef)
}

export async function testSshPaneConnection(args: {
  targetId: string
  mountedRef: MountedRef
  recordFeatureInteraction: (feature: 'ssh') => void | Promise<void>
  setTestingIds: (updater: (prev: Set<string>) => Set<string>) => void
}): Promise<void> {
  args.setTestingIds((prev) => new Set(prev).add(args.targetId))
  try {
    const result = await window.api.ssh.testConnection({ targetId: args.targetId })
    await args.recordFeatureInteraction('ssh')
    if (args.mountedRef.current) {
      if (result.success) {
        toast.success(
          translate('auto.components.settings.SshPane.81d08bcddf', 'Connection successful')
        )
      } else {
        toast.error(
          result.error
            ? formatSshUserFacingError(result.error)
            : translate('auto.components.settings.SshPane.0cda732f43', 'Connection test failed')
        )
      }
    }
  } catch (err) {
    if (args.mountedRef.current) {
      toast.error(
        formatSshErrorOrFallback(
          err,
          translate('auto.components.settings.SshPane.68c13b4589', 'Test failed')
        )
      )
    }
  } finally {
    if (args.mountedRef.current) {
      args.setTestingIds((prev) => {
        const next = new Set(prev)
        next.delete(args.targetId)
        return next
      })
    }
  }
}

export async function importSshPaneConfig(args: {
  mountedRef: MountedRef
  recordFeatureInteraction: (feature: 'ssh') => void | Promise<void>
  loadTargets: () => Promise<void>
}): Promise<void> {
  try {
    // Why: the explicit Import action re-adopts every ~/.ssh/config host,
    // including ones the user previously deleted — clear tombstones so a
    // deliberate re-import can bring them back.
    const result = await window.api.ssh.importConfig({ reAdopt: true })
    useAppStore.getState().recordSshRepoReadoptions(result.repoReadoptions)
    await args.recordFeatureInteraction('ssh')
    if (args.mountedRef.current) {
      if (result.targets.length === 0) {
        toast(
          translate(
            'auto.components.settings.SshPane.configAlreadyInSync',
            '~/.ssh/config already in sync'
          )
        )
      } else {
        toast.success(
          translate(
            'auto.components.settings.SshPane.f8050f6307',
            'Synced {{value0}} server{{value1}}',
            { value0: result.targets.length, value1: result.targets.length > 1 ? 's' : '' }
          )
        )
      }
    }
  } catch (err) {
    if (args.mountedRef.current) {
      toast.error(
        formatSshErrorOrFallback(
          err,
          translate('auto.components.settings.SshPane.f495689b82', 'Import failed')
        )
      )
    }
    return
  }
  await refreshSshTargetsBestEffort(args.loadTargets, args.mountedRef)
}
