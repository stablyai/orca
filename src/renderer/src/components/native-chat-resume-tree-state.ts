import { createContext, useState } from 'react'
import type {
  ResumeCandidate,
  ResumeFailure,
  ResumeWorkspaceGroup
} from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'

// The resume tree's shared state: which nodes are open, how deep a chat row sits, and how a chat
// is read by its key.

/**
 * Which nodes are open. Everything starts expanded; the state is this mount's own, so a dialog that
 * unmounts its tree on close reopens it fully expanded. Never persisted.
 */
export function useResumeTreeExpansion(): {
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
} {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  return {
    isExpanded: (key) => !collapsed.has(key),
    setExpanded: (key, expanded) =>
      setCollapsed((current) => {
        const next = new Set(current)
        if (expanded) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
  }
}

/** The tree depth a chat row renders at; the enclosing workspace node provides it. */
export const ResumeTreeDepthContext = createContext(0)

/** Lets a row that an earlier resume could not carry on show what went wrong and what to do. */
export type FailureProps = {
  failureFor?: (sessionId: string) => ResumeFailure | undefined
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
  renderStatus?: (sessionId: string, title: string) => React.ReactNode
  /** Current offer membership excludes completed run history from group selection. */
  selectableIds?: ReadonlySet<string>
}

/** What every node needs from the tree as a whole. */
export type TreeProps = {
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
  repoIdOf: (group: ResumeWorkspaceGroup) => string | null
  ancestorsOf: (group: ResumeWorkspaceGroup) => readonly string[]
} & FailureProps

/**
 * The one place a chat's key is read: its row's tick, toggle and failure, and every group's
 * coverage all go through here, so a change of key stays in this function.
 */
export function chatState(candidate: ResumeCandidate, tree: TreeProps) {
  const key = candidate.sessionId
  const failure = tree.failureFor?.(key)
  return {
    key,
    checked: tree.selected.has(key),
    onCheckedChange: (checked: boolean) => tree.onToggle(key, checked),
    failure,
    renderStatus: tree.renderStatus
      ? (_sessionId: string, title: string) => tree.renderStatus?.(key, title)
      : undefined,
    // A group checkbox never ticks a failure a retry cannot fix.
    selectable:
      (tree.selectableIds?.has(key) ?? true) && (!failure || resumeFailureSelectable(failure))
  }
}

/** The keys a group checkbox covers: every selectable chat under it. */
export function coveredKeys(candidates: readonly ResumeCandidate[], tree: TreeProps): string[] {
  return candidates
    .map((candidate) => chatState(candidate, tree))
    .filter((chat) => chat.selectable)
    .map((chat) => chat.key)
}
