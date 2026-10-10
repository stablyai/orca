import type { VoiceScreenSnapshot } from '../../../../shared/voice-control-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'

/**
 * Builds the describe_screen snapshot from renderer state. Pure over a narrow slice so
 * the mapping stays testable without the store; `collectVoiceScreenSnapshot` is the thin
 * store-reading wrapper the controller calls.
 */

export type VoiceScreenSnapshotSource = {
  activeView: string
  sidebarOpen: boolean
  rightSidebarOpen: boolean
  rightSidebarTab: string
  activeWorktreeId: string | null
  worktreesByRepo: Record<string, Worktree[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
}

function tabTitle(tab: Tab): string {
  return tab.customLabel ?? tab.generatedLabel ?? tab.label
}

export function buildVoiceScreenSnapshot(source: VoiceScreenSnapshotSource): VoiceScreenSnapshot {
  const worktreeId = source.activeWorktreeId
  const worktree = worktreeId
    ? Object.values(source.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === worktreeId)
    : undefined
  const group = worktreeId
    ? source.groupsByWorktree[worktreeId]?.find(
        (candidate) => candidate.id === source.activeGroupIdByWorktree[worktreeId]
      )
    : undefined
  const tabs = (worktreeId ? (source.unifiedTabsByWorktree[worktreeId] ?? []) : []).map((tab) => ({
    title: tabTitle(tab),
    contentType: tab.contentType,
    active: tab.id === group?.activeTabId
  }))
  const identity = worktree ? getWorktreeGitIdentityDisplay({ branch: worktree.branch }) : null
  return {
    view: source.activeView,
    worktreeName: worktree?.displayName ?? null,
    // The short branch name exactly as the sidebar shows it — the disambiguator when
    // two workspaces share a display name (two "main" worktrees).
    worktreeBranch: identity?.kind === 'branch' ? identity.branchName : null,
    tabs,
    leftSidebarOpen: source.sidebarOpen,
    rightSidebar: source.rightSidebarOpen ? source.rightSidebarTab : null
  }
}

export function collectVoiceScreenSnapshot(): VoiceScreenSnapshot {
  return buildVoiceScreenSnapshot(useAppStore.getState())
}
