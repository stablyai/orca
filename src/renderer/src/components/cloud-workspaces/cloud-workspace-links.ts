// App-level wiring for cloud workspaces: opening orca://cloud links, and which workspace is in front
// (a paired one's lease stays renewed while it is). Installed once from main.tsx; no React tree needed.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { parseCloudWorkspaceLink } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { reportCloudWorkspaceLinkFailure } from './cloud-workspace-link-failure'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { openCloudWorkspace } from './open-cloud-workspace'
import { focusCloudChat } from './cloud-chat-focus'
import { cloudWorkspacesAvailable } from './use-cloud-workspaces'
import { installCloudWorkspaceSync } from './cloud-workspace-sync'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'
import { installCloudAccessLostNotice } from './cloud-access-lost-toast'

/** No input for this long and the desktop stops renewing a paired workspace's lease. */
const IDLE_MS = 15 * 60_000

export async function handleCloudWorkspaceLink(link: string): Promise<void> {
  const parsed = parseCloudWorkspaceLink(link)
  if (!parsed || !(await cloudWorkspacesAvailable())) {
    return
  }
  const resolved = await window.api.cloudWorkspaces.resolveLink(parsed.target, parsed.chatId)
  if (!resolved.ok) {
    reportCloudWorkspaceLinkFailure(parsed.target, resolved, () => {
      void handleCloudWorkspaceLink(link)
    })
    return
  }
  const workspace = resolved.value.workspace
  rememberCloudWorkspaces([workspace])
  const outcome = await openCloudWorkspace(workspace)
  if (!outcome.ok) {
    if (!outcome.notified) {
      toast.error(outcome.message)
    }
  } else if (resolved.value.chatId) {
    await focusCloudChat(outcome.worktreeId, resolved.value.chatId)
  }
}

type Front = { sandboxId: string; owner: boolean } | null

const frontKey = (value: Front): string => (value ? `${value.sandboxId}:${value.owner}` : '')

async function resolveFront(): Promise<Front> {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  const hostId = state.activeWorkspaceExecutionHostId
  if (!worktreeId) {
    return null
  }
  const local = (await window.api.cloudWorkspaces.localWorkspaces()).find(
    (l) => l.worktreeId === worktreeId
  )
  if (local) {
    return { sandboxId: local.sandboxId, owner: true }
  }
  if (hostId) {
    const bindings = await window.api.cloudWorkspaces.environmentBindings()
    for (const [sandboxId, binding] of Object.entries(bindings)) {
      if (toRuntimeExecutionHostId(binding.environmentId) === hostId) {
        return { sandboxId, owner: false }
      }
    }
  }
  return null
}

export function installCloudWorkspaceLinks(): () => void {
  const cleanups: (() => void)[] = []
  const api = window.api.cloudWorkspaces
  if (!api) {
    return () => {}
  }
  cleanups.push(installCloudWorkspaceSync())
  // EP-8: a server that refuses this computer for good says so, with one fix.
  cleanups.push(installCloudAccessLostNotice())
  cleanups.push(
    api.onOpenLink((link) => {
      // The push already delivered it; drain the pending copy so a reload does not replay it.
      void api.consumePendingLink().catch(() => null)
      void handleCloudWorkspaceLink(link)
    })
  )
  void api.consumePendingLink().then((link) => link && void handleCloudWorkspaceLink(link))

  // Report the cloud workspace in front: a paired (not owned) one's lease is renewed while it is.
  // A hidden or idle window reports nothing, so an unattended desktop does not hold a VM awake.
  let last = ''
  let sequence = 0
  let idle = false
  const reportable = (): boolean => !idle && document.visibilityState === 'visible'
  const sync = async (): Promise<void> => {
    const ticket = ++sequence
    if (!(await cloudWorkspacesAvailable())) {
      return
    }
    const next = reportable() ? await resolveFront() : null
    // A newer sync started while this one awaited; its answer wins.
    if (ticket !== sequence) {
      return
    }
    const key = frontKey(next)
    if (key === last) {
      return
    }
    last = key
    await api.setActive(
      next ? { sandboxId: next.sandboxId, leased: !next.owner } : { sandboxId: null }
    )
  }
  cleanups.push(
    useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
      ) {
        void sync()
      }
    })
  )
  void sync()

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idle = true
      void sync()
    }, IDLE_MS)
  }
  const onInput = (): void => {
    armIdle()
    if (idle) {
      idle = false
      void sync()
    }
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      onInput()
    } else {
      void sync()
    }
  }
  armIdle()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pointerdown', onInput, true)
  cleanups.push(() => {
    clearTimeout(idleTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointerdown', onInput, true)
  })

  window.addEventListener('keydown', onInput, true)
  cleanups.push(() => window.removeEventListener('keydown', onInput, true))
  const onUnload = (): void => void api.setActive({ sandboxId: null })
  window.addEventListener('beforeunload', onUnload)
  cleanups.push(() => window.removeEventListener('beforeunload', onUnload))
  return () => cleanups.forEach((c) => c())
}
