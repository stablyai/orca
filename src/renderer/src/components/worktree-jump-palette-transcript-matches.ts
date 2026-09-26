import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { buildWorkspaceTabBaseResult } from '@/lib/workspace-tab-palette-results'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import type { OriginalPaneState } from './right-sidebar/ai-vault-original-pane'
import {
  buildAiVaultOriginalPaneIndex,
  findOriginalAiVaultSessionPaneInIndex
} from './right-sidebar/ai-vault-original-pane-index'
import { aiVaultSearchHitToSession } from './right-sidebar/ai-vault-search-session'
import { parseAiVaultSnippetMarks } from './right-sidebar/ai-vault-search-snippet-marks'
import type {
  PaletteTranscriptSnippet,
  WorkspaceTabPaletteItem
} from './worktree-jump-palette-model'

/** A local index hit that belongs to a terminal tab with a live or sleeping pane. */
export type PaletteTranscriptMatch = {
  worktreeId: string
  terminalTabId: string
  snippet: PaletteTranscriptSnippet | null
}

const NO_TRANSCRIPT_MATCHES: readonly PaletteTranscriptMatch[] = []
const NO_WORKSPACE_TAB_ITEMS: readonly WorkspaceTabPaletteItem[] = []

function terminalTabKey(worktreeId: string, terminalTabId: string): string {
  return `${worktreeId}\u0000${terminalTabId}`
}

/** Keeps host order; hits with no pane are dropped because Cmd+J lists only open chats. */
export function resolvePaletteTranscriptMatches(
  hits: readonly AiVaultSearchHit[],
  paneState: OriginalPaneState
): readonly PaletteTranscriptMatch[] {
  if (hits.length === 0) {
    return NO_TRANSCRIPT_MATCHES
  }
  const index = buildAiVaultOriginalPaneIndex(paneState)
  const seen = new Set<string>()
  const matches: PaletteTranscriptMatch[] = []
  for (const hit of hits) {
    const pane = findOriginalAiVaultSessionPaneInIndex(
      index,
      aiVaultSearchHitToSession(hit, LOCAL_EXECUTION_HOST_ID)
    )
    if (!pane) {
      continue
    }
    const key = terminalTabKey(pane.worktreeId, pane.tabId)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    matches.push({
      worktreeId: pane.worktreeId,
      terminalTabId: pane.tabId,
      snippet: hit.evidence ? parseAiVaultSnippetMarks(hit.evidence.snippet) : null
    })
  }
  return matches
}

/**
 * Title matches keep their order and gain the snippet; chats only the transcript
 * matched come back separately, in host order, for the caller to append.
 */
export function mergeWorkspaceTabTranscriptMatches({
  titleItems,
  entries,
  matches,
  context,
  isLocalWorktree
}: {
  titleItems: WorkspaceTabPaletteItem[]
  entries: readonly SearchableWorkspaceTab[]
  matches: readonly PaletteTranscriptMatch[]
  context: PaletteSearchContext
  /** Index hits come from this desktop only, and worktree ids can repeat across hosts. */
  isLocalWorktree: (worktree: Worktree) => boolean
}): {
  titleItems: WorkspaceTabPaletteItem[]
  transcriptOnlyItems: readonly WorkspaceTabPaletteItem[]
} {
  if (matches.length === 0) {
    return { titleItems, transcriptOnlyItems: NO_WORKSPACE_TAB_ITEMS }
  }
  const entryByTerminalTab = new Map<string, SearchableWorkspaceTab>()
  for (const entry of entries) {
    if (entry.tab.contentType !== 'terminal' || !isLocalWorktree(entry.worktree)) {
      continue
    }
    const key = terminalTabKey(entry.worktree.id, entry.tab.entityId)
    if (!entryByTerminalTab.has(key)) {
      entryByTerminalTab.set(key, entry)
    }
  }
  const titleItemIds = new Set(titleItems.map((item) => item.id))
  const snippetByItemId = new Map<string, PaletteTranscriptSnippet>()
  const transcriptOnlyItems: WorkspaceTabPaletteItem[] = []
  for (const match of matches) {
    const entry = entryByTerminalTab.get(terminalTabKey(match.worktreeId, match.terminalTabId))
    if (!entry) {
      continue
    }
    const result = buildWorkspaceTabBaseResult(entry, context)
    if (titleItemIds.has(result.paletteIdentity)) {
      if (match.snippet) {
        snippetByItemId.set(result.paletteIdentity, match.snippet)
      }
      continue
    }
    transcriptOnlyItems.push({
      id: result.paletteIdentity,
      type: 'workspace-tab',
      result,
      ...(match.snippet ? { transcriptSnippet: match.snippet } : {})
    })
  }
  return {
    titleItems:
      snippetByItemId.size === 0
        ? titleItems
        : titleItems.map((item) => {
            const snippet = snippetByItemId.get(item.id)
            return snippet ? { ...item, transcriptSnippet: snippet } : item
          }),
    transcriptOnlyItems
  }
}
