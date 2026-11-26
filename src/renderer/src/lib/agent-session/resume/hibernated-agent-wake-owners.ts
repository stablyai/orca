import type { WakeHibernatedAgentsWorktreeDetail } from '@/constants/terminal'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

type WakeOwner = {
  worktreeId: string
  tabId: string
  wake: (detail: WakeHibernatedAgentsWorktreeDetail) => void
}

const ownersByWorktree = new Map<string, Set<WakeOwner>>()
const ownersByTab = new Map<string, Set<WakeOwner>>()

function addOwner(index: Map<string, Set<WakeOwner>>, key: string, owner: WakeOwner): () => void {
  const owners = index.get(key) ?? new Set()
  index.set(key, owners.add(owner))
  return () => {
    owners.delete(owner)
    if (owners.size === 0 && index.get(key) === owners) {
      index.delete(key)
    }
  }
}

/** A mounted terminal tab that can wake its own hibernated agents. */
export function registerHibernatedAgentWakeOwner(owner: WakeOwner): () => void {
  const releaseWorktree = addOwner(ownersByWorktree, owner.worktreeId, owner)
  const releaseTab = addOwner(ownersByTab, owner.tabId, owner)
  return () => {
    releaseWorktree()
    releaseTab()
  }
}

/** A workspace wake reaches that workspace's mounted tabs; a pane wake reaches only the pane's own tab. */
export function dispatchHibernatedAgentWake(detail: WakeHibernatedAgentsWorktreeDetail): void {
  const tabId = detail.paneKey ? parsePaneKey(detail.paneKey)?.tabId : undefined
  const owners = tabId ? ownersByTab.get(tabId) : ownersByWorktree.get(detail.worktreeId)
  for (const owner of owners ? [...owners] : []) {
    if (owner.worktreeId === detail.worktreeId) {
      owner.wake(detail)
    }
  }
}
