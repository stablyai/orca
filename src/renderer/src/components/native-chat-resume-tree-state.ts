import { createContext, useState } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host'
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

/** Separates a choice's listing from its node key; neither contains it. */
const LISTING_SEPARATOR = '\u0001'

/**
 * Which nodes are open. Everything starts expanded unless `defaultExpanded` says otherwise; what the
 * user opens or closes then wins, also over a default that changes as answers arrive. The state is
 * this mount's own, so a dialog that unmounts its tree on close reopens it from the defaults. Never
 * persisted.
 *
 * With `listings`, a choice belongs to the listing its node's host was shown under (a paired server
 * re-paired is a new listing) and goes when that listing is no longer shown, so a machine that
 * leaves and comes back starts from its defaults again.
 */
export function useResumeTreeExpansion(
  defaultExpanded?: (key: string) => boolean,
  listings?: { listingOf: (hostId: ExecutionHostId) => string; shown: readonly string[] }
): {
  isExpanded: (key: string, hostId?: ExecutionHostId) => boolean
  setExpanded: (key: string, expanded: boolean, hostId?: ExecutionHostId) => void
} {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const entry = (key: string, hostId: ExecutionHostId | undefined) =>
    listings && hostId !== undefined
      ? `${listings.listingOf(hostId)}${LISTING_SEPARATOR}${key}`
      : key
  if (listings) {
    const shown = new Set(listings.shown)
    const kept = [...chosen].filter(([stored]) => {
      const at = stored.indexOf(LISTING_SEPARATOR)
      return at === -1 || shown.has(stored.slice(0, at))
    })
    // Render-time adjustment of this hook's own state: a listing gone takes its choices with it.
    if (kept.length !== chosen.size) {
      setChosen(new Map(kept))
    }
  }
  return {
    isExpanded: (key, hostId) => chosen.get(entry(key, hostId)) ?? defaultExpanded?.(key) ?? true,
    setExpanded: (key, expanded, hostId) =>
      setChosen((current) => new Map(current).set(entry(key, hostId), expanded))
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

/** What a caller listing several machines adds: chats are keyed by `rowKey` (two machines may
 *  hold the same session id), so `selected`, `onToggle`, `failureFor`, `onFailureAction` and
 *  `originLabelFor` all take that key; each machine can be busy on its own, start open or closed,
 *  and carry a line beside its name. */
export type MachineProps = {
  /** A chat's key in every lookup; the session id when absent. */
  rowKey?: (candidate: ResumeCandidate) => string
  /** One machine mid-resume locks only its own nodes. */
  busyFor?: (hostId: ExecutionHostId) => boolean
  /** Where a chat that does not start ticked came from ("Automation", "Another device"). */
  originLabelFor?: (key: string) => string | undefined
  /** Whether a node starts open; the user's own opening and closing then wins. */
  defaultExpanded?: (nodeKey: string) => boolean
  /** A line beside a machine's name, e.g. why it stopped and when. */
  machineSubtitle?: (hostId: ExecutionHostId) => string | undefined
  /** The listing a host's chats were shown under (a re-paired server is a new one): what the user
   *  opened or closed under it holds only for it. */
  listingOf?: (hostId: ExecutionHostId) => string
}

/** What every node needs from the tree as a whole. */
export type TreeProps = {
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
  isExpanded: (key: string, hostId?: ExecutionHostId) => boolean
  setExpanded: (key: string, expanded: boolean, hostId?: ExecutionHostId) => void
  repoIdOf: (group: ResumeWorkspaceGroup) => string | null
  ancestorsOf: (group: ResumeWorkspaceGroup) => readonly string[]
} & FailureProps &
  Pick<MachineProps, 'rowKey' | 'busyFor' | 'originLabelFor'>

/** Whether a node on this host is locked: the whole tree, or this machine, is mid-resume. */
export function treeBusy(tree: TreeProps, hostId: ExecutionHostId): boolean {
  return tree.busy || tree.busyFor?.(hostId) === true
}

/**
 * The one place a chat's key is read: its row's tick, toggle and failure, and every group's
 * coverage all go through here, so a change of key stays in this function.
 */
export function chatState(candidate: ResumeCandidate, tree: TreeProps) {
  const key = tree.rowKey?.(candidate) ?? candidate.sessionId
  const failure = tree.failureFor?.(key)
  return {
    key,
    checked: tree.selected.has(key),
    onCheckedChange: (checked: boolean) => tree.onToggle(key, checked),
    failure,
    // The row's own actions, where it came from and its run status, named by the same key.
    onFailureAction:
      tree.onFailureAction &&
      ((action: ResumeFailureAction) => tree.onFailureAction?.(action, key)),
    originLabel: tree.originLabelFor?.(key),
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
