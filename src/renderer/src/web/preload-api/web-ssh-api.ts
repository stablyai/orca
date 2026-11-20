import type { PreloadApi } from '../../../../preload/api-types'
import type {
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConnectionState,
  SshConfigImportResult,
  PortForwardEntry,
  SshTarget,
  SshTargetAddResult
} from '../../../../shared/remote-runtime/ssh/ssh-types'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { requireActiveEnvironmentOrNull } from '../runtime/client/web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import {
  onSshCredentialRequest,
  onSshCredentialResolved,
  onSshPortForwardsChanged,
  onSshStateChanged
} from './web-ssh-runtime-events'
import { admitSshConnectionStateForAuthorityReconciliation } from '../../../../shared/remote-runtime/ssh/ssh-retained-payload-admission'

export function createSshApi(): NonNullable<Partial<PreloadApi>['ssh']> {
  return {
    onTargetRemoved: () => () => {},
    // Why: SSH is owned by the paired runtime; keep target mutations on that host instead of
    // silently maintaining a second browser-only copy.
    listTargets: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      const { targets } = await callRuntimeResult<{ targets: SshTarget[] }>(
        'ssh.listTargetSummaries'
      )
      return targets
    },
    listRemovedTargetLabels: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return {}
      }
      const { labels } = await callRuntimeResult<{ labels: Record<string, string> }>(
        'ssh.listRemovedTargetLabels'
      )
      return labels
    },
    addTarget: (args) => callRuntimeResult<SshTargetAddResult>('ssh.addTarget', args),
    updateTarget: async ({ id, updates }) =>
      callRuntimeResult<{ target: SshTarget }>('ssh.updateTarget', {
        targetId: id,
        target: updates
      }).then(({ target }) => target),
    removeTarget: async ({ id }) => {
      await callRuntimeResult('ssh.removeTarget', { targetId: id })
    },
    importConfig: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return { targets: [], repoReadoptions: [] }
      }
      return callRuntimeResult<SshConfigImportResult>('ssh.importConfig', args ?? {})
    },
    listConfigHosts: async (args?: SshConfigHostListArgs) => {
      if (!requireActiveEnvironmentOrNull()) {
        return {
          hosts: [],
          totalHostCount: 0,
          newHostCount: 0,
          matchCount: 0,
          hasMore: false
        }
      }
      return callRuntimeResult<SshConfigHostListResult>('ssh.listConfigHosts', args ?? {})
    },
    resolveConfigHost: async (args: { alias: string }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      return callRuntimeResult<SshConfigHostResolution | null>('ssh.resolveConfigHost', args)
    },
    connect: async (args) => {
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.connect',
        { targetId: args.targetId, automatic: args.automatic }
      )
      return state
    },
    disconnect: async ({ targetId }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return
      }
      await callRuntimeResult('ssh.disconnect', { targetId })
    },
    getState: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.getState',
        { targetId: args.targetId }
      )
      return state
    },
    needsPassphrasePrompt: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return false
      }
      const { needsPrompt } = await callRuntimeResult<{ needsPrompt: boolean }>(
        'ssh.needsPassphrasePrompt',
        { targetId: args.targetId }
      )
      return needsPrompt
    },
    testConnection: (args: { targetId: string }) =>
      // Why: orcad returns state on success and omits it on failure, never null — match the preload contract.
      callRuntimeResult<{ success: boolean; error?: string; state?: SshConnectionState }>(
        'ssh.testConnection',
        { targetId: args.targetId }
      ),
    // Why: match Electron's ssh:state-changed fan-out; orcad already publishes
    // sshStateChanged for the paired host, the web client just dropped it.
    onStateChanged: (callback) =>
      onSshStateChanged((change) => {
        const state = admitSshConnectionStateForAuthorityReconciliation(
          change.state,
          change.targetId
        )
        if (state) {
          callback({ targetId: change.targetId, state })
        }
      }),
    addPortForward: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        throw new Error('SSH port forwarding requires an active runtime.')
      }
      return callRuntimeResult<PortForwardEntry>('ssh.addPortForward', args)
    },
    updatePortForward: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        throw new Error('SSH port forwarding requires an active runtime.')
      }
      return callRuntimeResult<PortForwardEntry>('ssh.updatePortForward', args)
    },
    removePortForward: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      return callRuntimeResult<PortForwardEntry | null>('ssh.removePortForward', args)
    },
    listPortForwards: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      return callRuntimeResult<PortForwardEntry[]>('ssh.listPortForwards', args ?? {})
    },
    listUnrestoredPortForwards: async () => {
      // Unrestored forwards live in the paired runtime's renderer; browser-only
      // hosts have none to surface.
      return []
    },
    removeSavedPortForward: async () => {
      // Saved forwards are persisted on the paired runtime host; no-op here.
    },
    listDetectedPorts: () => Promise.resolve([]),
    onPortForwardsChanged: onSshPortForwardsChanged,
    onDetectedPortsChanged: () => noopUnsubscribe,
    browseDir: async ({ targetId, dirPath }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return { entries: [], resolvedPath: '', pathFlavor: 'posix' as const }
      }
      return callRuntimeResult('ssh.browseDir', { targetId, dirPath })
    },
    onCredentialRequest: onSshCredentialRequest,
    onCredentialResolved: onSshCredentialResolved,
    submitCredential: ({ requestId, value }) =>
      callRuntimeResult('ssh.submitCredential', { requestId, value })
  }
}
