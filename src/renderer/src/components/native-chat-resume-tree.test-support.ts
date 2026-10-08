// Fixtures and DOM lookups shared by the resume tree's test files.

import { vi, type Mock } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'

export function worktree(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::/repo/${name}`,
    instanceId: `instance-${name}`,
    repoId: 'repo-1',
    path: `/repo/${name}`,
    displayName: name,
    branch: `refs/heads/${name}-branch`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

export function candidate(sessionId: string, workspace: Worktree): ResumeCandidate {
  return {
    sessionId,
    workspaceId: workspace.id,
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: `Prompt ${sessionId}`,
    recordedAt: 1_800_000_000_000,
    executionHostId: workspace.hostId ?? 'local',
    workspaceKind: 'git-worktree'
  }
}

export function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

/** A failure the host says a retry cannot fix. */
export function unretryable(entry: ResumeCandidate): ResumeFailure {
  return {
    ...entry,
    failedAt: 1_800_000_030_000,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  }
}

/** Repo "orca": parent (1 chat) > child (2 chats), plus an unrelated root workspace "other". */
export function seedTree(hosts: { parent?: ExecutionHostId; child?: ExecutionHostId } = {}) {
  // An explicit undefined is a row with no host id (older metadata).
  const parentHost = 'parent' in hosts ? hosts.parent : 'local'
  const parent = worktree('parent', { hostId: parentHost })
  const child = worktree('child', { hostId: 'child' in hosts ? hosts.child : 'local' })
  const other = worktree('other', { hostId: parentHost })
  useAppStore.setState({
    settings: getDefaultSettings(''),
    repos: [
      { id: 'repo-1', path: '/repo', displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
    ],
    worktreesByRepo: { 'repo-1': [parent, child, other] },
    worktreeLineageById: { [child.id]: lineage(child, parent) }
  })
  return [
    candidate('in-child', child),
    candidate('in-parent', parent),
    candidate('also-in-child', child),
    candidate('in-other', other)
  ]
}

export const onToggleSpy: Mock<(sessionId: string, checked: boolean) => void> = vi.fn()

/** A group node's checkbox: workspace or project ("in"), machine ("on"). */
export function nodeBox(name: string): HTMLElement {
  const box = document.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label="Select all chats in ${name}"], [role="checkbox"][aria-label="Select all chats on ${name}"]`
  )
  if (!box) {
    throw new Error(`Missing node checkbox: ${name}`)
  }
  return box
}

export function chatBox(sessionId: string): HTMLElement {
  const box = document.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label*="Prompt ${sessionId}"]`
  )
  if (!box) {
    throw new Error(`Missing chat checkbox: ${sessionId}`)
  }
  return box
}

export function queryChatBox(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="checkbox"][aria-label*="Prompt ${sessionId}"]`)
}

export function itemOf(box: HTMLElement): HTMLElement {
  return box.closest<HTMLElement>('[role="treeitem"]')!
}

/** The group node's "x of y". */
export function countOf(name: string): string | undefined {
  return itemOf(nodeBox(name)).querySelector('.tabular-nums')?.textContent ?? undefined
}

export function disclosureOf(name: string): HTMLButtonElement {
  return itemOf(nodeBox(name)).querySelector<HTMLButtonElement>('button[aria-expanded]')!
}

/** Each tree row in order, as level:kind:name, kind read off the name's weight. */
export function treeOutline(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((item) => {
    const level = item.getAttribute('aria-level')
    const label = item.querySelector('[role="checkbox"]')?.getAttribute('aria-label') ?? ''
    const chat = /Prompt ([\w-]+)/.exec(label)?.[1]
    if (chat) {
      return `${level}:chat:${chat}`
    }
    const name = /^Select all chats (?:in|on) (.+)$/.exec(label)?.[1]
    const kind = item.querySelector('.font-bold')
      ? 'machine'
      : item.querySelector('.font-semibold')
        ? 'project'
        : 'workspace'
    return `${level}:${kind}:${name}`
  })
}
