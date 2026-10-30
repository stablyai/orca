import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { usesAgentLaunchList, type AgentLaunchListEntry } from '@/lib/pending-worktree-creation'

/** One ordered composer agent row. Rows are keyed by `id`, so repeated harnesses stay distinct. */
export type ComposerAgentEntry = {
  id: string
  draft: AgentPickerDraft
  displayName: string
}

// A row starts before its picker catalog settles, so its draft carries no inherited
// defaults: an unknown catalog entry launches the CLI on the terminal surface, and
// the row's own setup panel owns every later choice.
const COMPOSER_DRAFT_ENTRY: Omit<AgentPickerEntry, 'agent'> = {
  label: '',
  rows: [],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

export function createComposerAgentEntry(agent: TuiAgent): ComposerAgentEntry {
  return {
    id: createBrowserUuid(),
    draft: agentPickerDraft({ ...COMPOSER_DRAFT_ENTRY, agent }),
    displayName: ''
  }
}

/** Map composer rows to the serializable launch list Retry replays; blank labels are omitted
 * so the catalog label wins, and duplicate labels are allowed (rows stay distinct by order). */
export function entriesToLaunchList(entries: ComposerAgentEntry[]): AgentLaunchListEntry[] {
  return entries.map((entry) => {
    const displayName = entry.displayName.trim()
    return {
      agent: entry.draft.agent,
      ...agentPickerLaunchInputs(entry.draft),
      requestedSurface: entry.draft.surface,
      ...(displayName ? { displayName } : {})
    }
  })
}

/** A lone flag-less, name-less row keeps the legacy `request.agent` submit path. Delegates to
 * `usesAgentLaunchList` so composer state and retry replay cannot disagree about the path. */
export function isLegacySingleAgentSubmit(entries: ComposerAgentEntry[]): boolean {
  const agentLaunches = entriesToLaunchList(entries)
  return !usesAgentLaunchList({ agent: agentLaunches[0]?.agent ?? null, agentLaunches })
}

/** Composer rows reach submit with the detection-resolved quick pick beside them; the legacy
 * path uses that pick, while the list path maps these rows verbatim (row 0 may lag the pick). */
export type ComposerAgentSubmitSelection = {
  entries: ComposerAgentEntry[]
  /** Folder/remote/VM targets collapse the rows to the legacy first-row pick. */
  locked: boolean
  /** Row 0's live quick pick; `null` (Blank Terminal) cannot become a launch entry. */
  rowZeroAgent: TuiAgent | null
}

/** Resolve the post-create launch list, or `null` to keep the legacy single-agent submit.
 * The multi-agent list is local-git-worktree only (resolution 2) and only when a row carries
 * flags, session options or a custom name (resolution 3). */
export function resolveComposerAgentLaunchList(args: {
  selection: ComposerAgentSubmitSelection | undefined
  gitWorktree: boolean
  /** Resolution 2: remote hosts collapse the rows to the legacy first-row pick. */
  remote: boolean
}): AgentLaunchListEntry[] | null {
  const selection = args.selection
  if (!selection || selection.locked || !args.gitWorktree || args.remote) {
    return null
  }
  // Resolution 3: Blank Terminal on row 0 has no launch entry of its own; the remaining rows
  // carry the launch. A lone bare remainder must not fall back to the legacy path with the
  // Blank Terminal pick, or the user's extra agent is silently dropped (CodeRabbit #6): the
  // remainder itself becomes the legacy agent.
  const remainder = selection.rowZeroAgent === null ? selection.entries.slice(1) : selection.entries
  if (remainder.length === 0) {
    return null
  }
  return isLegacySingleAgentSubmit(remainder) ? null : entriesToLaunchList(remainder)
}

/** The agent the legacy submit path launches after the launch-list resolution: the row-0 pick,
 * except when row 0 is Blank Terminal and a remainder row survives — then the remainder's own
 * agent, so the agent row the user added still launches (CodeRabbit #6). */
export function resolveLegacySubmitAgent(
  selection: ComposerAgentSubmitSelection | undefined
): TuiAgent | null {
  if (!selection) {
    return null
  }
  if (selection.rowZeroAgent !== null) {
    return selection.rowZeroAgent
  }
  const remainder = selection.entries.slice(1)
  const bareRemainder = remainder.length === 1 && isLegacySingleAgentSubmit(remainder)
  return bareRemainder ? remainder[0].draft.agent : null
}
