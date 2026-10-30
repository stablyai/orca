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
}

/** Resolve the post-create launch list, or `null` to keep the legacy single-agent submit.
 * The multi-agent list is local-git-worktree only (resolution 2) and only when a row carries
 * flags, session options or a custom name (resolution 3). */
export function resolveComposerAgentLaunchList(args: {
  selection: ComposerAgentSubmitSelection | undefined
  gitWorktree: boolean
}): AgentLaunchListEntry[] | null {
  const selection = args.selection
  if (!selection || selection.locked || !args.gitWorktree || selection.entries.length === 0) {
    return null
  }
  return isLegacySingleAgentSubmit(selection.entries)
    ? null
    : entriesToLaunchList(selection.entries)
}
