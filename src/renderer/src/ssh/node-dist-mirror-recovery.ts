/** Opening, saving and retrying the Node.js mirror recovery for an SSH host's failed setup. */
import {
  normalizeNodeDistMirrorUrl,
  type NodeDistMirrorRefusal
} from '../../../shared/node-dist-mirror'
import type { SshManagedServerStatus } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { useAppStore } from '@/store'
import {
  isSshConnectInFlight,
  subscribeSshConnectInFlight,
  trackSshConnect
} from './ssh-connect-in-flight'
import {
  blockedNodeDownload,
  nodeMirrorRecovery,
  type NodeMirrorRecovery
} from './ssh-host-node-download-copy'

export const NODE_DIST_MIRROR_SUGGESTION = 'https://npmmirror.com/mirrors/node/'

/**
 * The recovery this window can carry out. Only this desktop's own SSH targets qualify: the mirror
 * setting lives in its main process, not on another server or in a paired browser.
 */
export function thisComputerNodeMirrorRecovery(
  status: SshManagedServerStatus | undefined,
  ownerEnvironmentId: string | null,
  configuredMirror = useAppStore.getState().settings?.nodeDistMirrorUrl
): NodeMirrorRecovery | null {
  if (ownerEnvironmentId || isPairedWebClientWindow()) {
    return null
  }
  return nodeMirrorRecovery(status, configuredMirror)
}

/** Decided again on click: a toast's action can outlive a mirror set in Settings meanwhile. */
export function runNodeMirrorRecovery(targetId: string): void {
  const { sshConnectionStates } = useAppStore.getState()
  const recovery = thisComputerNodeMirrorRecovery(
    sshConnectionStates.get(targetId)?.managedServer,
    null
  )
  if (recovery) {
    openNodeMirrorRecovery(targetId, recovery)
  }
}

export function openNodeMirrorRecovery(targetId: string, recovery: NodeMirrorRecovery): void {
  if (recovery === 'offer') {
    useAppStore.getState().openModal('node-dist-mirror', { targetId })
  } else {
    openNodeDistMirrorSettings()
  }
}

export function readNodeDistMirrorDialogTarget(data: Record<string, unknown>): string | null {
  return typeof data.targetId === 'string' && data.targetId ? data.targetId : null
}

// Why a search, not a scroll target: it also opens the collapsed fields when only the environment
// variable set the mirror.
function openNodeDistMirrorSettings(): void {
  const { openSettingsPage, openSettingsTarget, setSettingsSearchQuery } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'advanced', repoId: null })
  setSettingsSearchQuery(
    translate('auto.components.settings.general.search.nodeDistMirror', 'mirror')
  )
}

export type SaveNodeDistMirrorResult =
  | { outcome: 'retrying'; retry: Promise<unknown> }
  | { outcome: 'refused'; reason: NodeDistMirrorRefusal }
  | { outcome: 'save-failed'; message: string }

const defaultDeps = {
  save: (nodeDistMirrorUrl: string) =>
    useAppStore.getState().updateSettingsOrThrow({ nodeDistMirrorUrl }),
  connect: (targetId: string) => window.api.ssh.connect({ targetId })
}

/**
 * Saves through the same setting and IPC as Settings > Advanced > Network, then connects again.
 * Why save first: main reads the setting when the connect downloads Node.
 */
export async function saveNodeDistMirrorAndRetry(
  targetId: string,
  text: string,
  deps: {
    save: (nodeDistMirrorUrl: string) => Promise<void>
    connect: (targetId: string) => Promise<unknown>
  } = defaultDeps
): Promise<SaveNodeDistMirrorResult> {
  const normalized = normalizeNodeDistMirrorUrl(text)
  if (!normalized.ok) {
    return { outcome: 'refused', reason: normalized.reason }
  }
  // Why: an empty field would clear the setting, which is no mirror at all.
  if (!normalized.value) {
    return { outcome: 'refused', reason: 'invalid' }
  }
  try {
    await deps.save(normalized.value)
  } catch (error) {
    return {
      outcome: 'save-failed',
      message:
        error instanceof Error && error.message
          ? error.message
          : translate(
              'auto.components.settings.nodeDistMirrorDialog.saveFailed',
              'Orca couldn’t save the mirror.'
            )
    }
  }
  if (!isSshConnectInFlight(targetId)) {
    return { outcome: 'retrying', retry: trackSshConnect(targetId, deps.connect(targetId)) }
  }
  // Why wait: a second connect would race the one dialing, which may be past the download already.
  // The status is current once the lock clears: main publishes a failed setup before it rejects.
  const retry = sshConnectSettled(targetId).then(() =>
    blockedNodeDownload(useAppStore.getState().sshConnectionStates.get(targetId)?.managedServer)
      ? trackSshConnect(targetId, deps.connect(targetId))
      : undefined
  )
  return { outcome: 'retrying', retry }
}

/** Resolves once no connect for `targetId` holds the shared in-flight lock. */
function sshConnectSettled(targetId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeSshConnectInFlight(() => {
      if (!isSshConnectInFlight(targetId)) {
        unsubscribe()
        resolve()
      }
    })
  })
}
