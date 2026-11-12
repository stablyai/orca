// App-level sync for cloud workspace arrangement and identity, installed with the link wiring:
// follows the signed-in account, polls this member's synced prefs (pins, order, sections) while the
// window is visible, keeps W-numbers and links for the palette and headers, and names the org's
// link slug the first time anyone in the org asks (the control plane only knows org ids).
import { useAppStore } from '@/store'
import { getOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { cloudWorkspacesAvailable } from './use-cloud-workspaces'
import {
  PREFS_POLL_MS,
  editCloudWorkspacePrefs,
  refreshCloudWorkspacePrefs,
  setPrefsAccount
} from './cloud-workspace-prefs'
import {
  cloudWorkspaceIdentity,
  refreshCloudWorktreeBindings,
  rememberCloudWorkspaces,
  sandboxIdForWorktree
} from './cloud-workspace-identity'
import { setPinned } from '../../../../shared/cloud-workspaces/cloud-workspace-arrangement'
import { onWorktreesPinnedByUser } from '@/lib/orca-cloud/worktree-pin-listeners'

/** Numbers and links rarely change; Home's own polling refreshes them faster while it is open. */
const IDENTITY_POLL_MS = 60_000
const FRONT_RETRY_MS = 5_000

export function installCloudWorkspaceSync(): () => void {
  const api = window.api.cloudWorkspaces
  if (!api) {
    return () => {}
  }
  let account: string | null = null
  const sluggedAccounts = new Set<string>()

  const refreshIdentity = async (): Promise<void> => {
    if (!account || !(await cloudWorkspacesAvailable())) {
      return
    }
    const forAccount = account
    const [list] = await Promise.all([
      api.list({ scope: 'team', archived: 'include' }),
      refreshCloudWorktreeBindings()
    ])
    if (list.ok && account === forAccount) {
      rememberCloudWorkspaces(list.value)
    }
  }

  const ensureSlug = async (): Promise<void> => {
    const status = useAppStore.getState().orcaProfileAuthStatus
    const orgName = status?.cloud?.activeOrgName
    if (!account || !status?.cloud?.activeOrgId || sluggedAccounts.has(account)) {
      return
    }
    const forAccount = account
    const result = await api.getOrgSlug(orgName ?? null)
    if (result.ok && result.value.slug && account === forAccount) {
      sluggedAccounts.add(forAccount)
      // Links in the list now carry the slug form.
      void refreshIdentity()
    }
  }

  const follow = (): void => {
    const status = useAppStore.getState().orcaProfileAuthStatus
    const next = status?.state === 'connected' ? getOrcaAccountKey(status) : null
    const key = next === 'signed-out' ? null : next
    if (key === account) {
      return
    }
    account = key
    setPrefsAccount(key)
    if (key) {
      void cloudWorkspacesAvailable().then((available) => {
        if (available && account === key) {
          void refreshCloudWorkspacePrefs()
          void ensureSlug().then(refreshIdentity)
        }
      })
    }
  }

  const cleanups: (() => void)[] = []
  cleanups.push(
    useAppStore.subscribe((state, previous) => {
      if (state.orcaProfileAuthStatus !== previous.orcaProfileAuthStatus) {
        follow()
      }
    })
  )
  follow()
  cleanups.push(
    installWindowVisibilityInterval({
      run: () => void refreshCloudWorkspacePrefs(),
      intervalMs: PREFS_POLL_MS
    })
  )
  cleanups.push(
    installWindowVisibilityInterval({
      run: () => void ensureSlug().then(refreshIdentity),
      intervalMs: IDENTITY_POLL_MS
    })
  )
  // Pinning a cloud workspace's row in the sidebar pins it in your synced prefs too.
  cleanups.push(
    onWorktreesPinnedByUser((targets, isPinned) => {
      const ids = [...new Set(targets.flatMap((target) => sandboxIdForWorktree(target) ?? []))]
      if (account && ids.length > 0) {
        void editCloudWorkspacePrefs((doc) =>
          ids.reduce((next, id) => setPinned(next, id, isPinned), doc)
        )
      }
    })
  )
  // Switching to a workspace (a new cloud one just created or paired, too) re-reads which local
  // runtimes are cloud workspaces, and fetches numbers when the one in front has none yet. A
  // runtime registers a moment after it opens, so a miss is checked once more shortly after.
  let followUp: ReturnType<typeof setTimeout> | undefined
  const identifyFront = async (): Promise<boolean> => {
    await refreshCloudWorktreeBindings()
    const state = useAppStore.getState()
    const id = state.activeWorktreeId
    const sandboxId = id
      ? sandboxIdForWorktree({ id, hostId: state.activeWorkspaceExecutionHostId })
      : null
    if (sandboxId && !cloudWorkspaceIdentity(sandboxId)?.number) {
      await refreshIdentity()
    }
    return sandboxId !== null || !id
  }
  cleanups.push(
    useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
      ) {
        clearTimeout(followUp)
        void identifyFront().then((known) => {
          if (!known) {
            followUp = setTimeout(() => void identifyFront(), FRONT_RETRY_MS)
          }
        })
      }
    })
  )
  cleanups.push(() => clearTimeout(followUp))
  return () => {
    cleanups.forEach((cleanup) => cleanup())
    setPrefsAccount(null)
  }
}
