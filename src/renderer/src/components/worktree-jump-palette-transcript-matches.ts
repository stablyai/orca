import {
  buildPaletteTranscriptIndex,
  type PaletteTranscriptIndex,
  type PaletteTranscriptState
} from './cmd-j/palette-transcript-structured-tabs'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { buildWorkspaceTabBaseResult } from '@/lib/workspace-tab-palette-results'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import { resolveOriginalPaneTarget } from './right-sidebar/ai-vault-original-pane'
import { findOriginalAiVaultSessionPanesInIndex } from './right-sidebar/ai-vault-original-pane-index'
import { aiVaultSearchHitToSession } from './right-sidebar/ai-vault-search-session'
import { parseAiVaultSnippetMarks } from './right-sidebar/ai-vault-search-snippet-marks'
import type {
  PaletteTranscriptSnippet,
  WorkspaceTabPaletteItem
} from './worktree-jump-palette-model'
import {
  classifyPaletteTranscriptProof,
  preparePaletteTranscriptProofQuery,
  type PaletteTranscriptWindow
} from './cmd-j/palette-transcript-proof'

/** An index hit connected to an open terminal or structured chat on its host. */
export type PaletteTranscriptMatch = {
  executionHostId?: ExecutionHostId
  worktreeId: string
  tabId: string
  snippet: PaletteTranscriptSnippet | null
  ordinal: number
  complete: boolean
  windows: readonly PaletteTranscriptWindow[]
}

const NO_TRANSCRIPT_MATCHES: readonly PaletteTranscriptMatch[] = []
const NO_WORKSPACE_TAB_ITEMS: readonly WorkspaceTabPaletteItem[] = []

export function paletteTranscriptTabKey(
  worktreeId: string,
  tabId: string,
  executionHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): string {
  return executionHostId === LOCAL_EXECUTION_HOST_ID
    ? `${worktreeId}\u0000${tabId}`
    : JSON.stringify([executionHostId, worktreeId, tabId])
}

export function resolvePaletteTranscriptEligibleTabs(
  state: PaletteTranscriptState,
  index: PaletteTranscriptIndex = buildPaletteTranscriptIndex(state)
): ReadonlySet<string> {
  const keys = new Set<string>()
  const panes = [
    ...Object.values(state.agentStatusByPaneKey).filter((entry) => entry.agentType),
    ...Object.values(state.retainedAgentsByPaneKey)
      .filter((entry) => entry?.agentType)
      .map((entry) => entry.entry),
    ...Object.values(state.sleepingAgentSessionsByPaneKey).filter((entry) => entry !== undefined)
  ]
  for (const pane of panes) {
    const target = resolveOriginalPaneTarget({
      state,
      paneKey: pane.paneKey,
      worktreeIdHint: pane.worktreeId,
      tabIdHint: pane.tabId
    })
    if (target) {
      keys.add(paletteTranscriptTabKey(target.worktreeId, target.tabId, index.executionHostId))
    }
  }
  for (const tab of index.structuredTabs) {
    keys.add(paletteTranscriptTabKey(tab.worktreeId, tab.tabId, index.executionHostId))
  }
  return keys
}

/** Keeps host order; hits with no pane are dropped because Cmd+J lists only open chats. */
export function resolvePaletteTranscriptMatches(
  hits: readonly AiVaultSearchHit[],
  paneState: PaletteTranscriptState,
  query = '',
  proofWindows?: ReadonlyMap<AiVaultSearchHit, readonly PaletteTranscriptWindow[]>,
  preparedIndex?: PaletteTranscriptIndex
): readonly PaletteTranscriptMatch[] {
  if (hits.length === 0) {
    return NO_TRANSCRIPT_MATCHES
  }
  const index = preparedIndex ?? buildPaletteTranscriptIndex(paneState)
  const requirements = proofWindows ? null : preparePaletteTranscriptProofQuery(query)
  const matches: PaletteTranscriptMatch[] = []
  for (const [ordinal, hit] of hits.entries()) {
    if ((hit.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== index.executionHostId) {
      continue
    }
    const panes = findOriginalAiVaultSessionPanesInIndex(
      index.terminalPanes,
      aiVaultSearchHitToSession(hit, index.executionHostId)
    )
    const targets = [
      ...panes,
      ...(index.structuredTabsByAgent.get(hit.agent)?.get(hit.sessionId) ?? [])
    ]
    const distinctTabs = new Map(
      targets.map((pane) => [paletteTranscriptTabKey(pane.worktreeId, pane.tabId), pane])
    )
    if (distinctTabs.size === 0) {
      continue
    }
    const snippet = hit.evidence ? parseAiVaultSnippetMarks(hit.evidence.snippet) : null
    const windows =
      proofWindows?.get(hit) ??
      classifyPaletteTranscriptProof(
        hit.evidence?.originalExcerpt?.text ?? '',
        requirements ?? query,
        hit.evidence?.originalExcerpt
      )
    for (const pane of distinctTabs.values()) {
      matches.push({
        ...(index.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? { executionHostId: index.executionHostId }
          : {}),
        worktreeId: pane.worktreeId,
        tabId: pane.tabId,
        snippet,
        ordinal,
        complete: false,
        windows
      })
    }
  }
  return matches
}

/** Fit and classify before folding sessions onto one destination. */
export function fitPaletteTranscriptMatches(
  matches: readonly PaletteTranscriptMatch[],
  fits: ReadonlyMap<number, PaletteTranscriptSnippet>
): readonly PaletteTranscriptMatch[] {
  const byTab = new Map<string, PaletteTranscriptMatch>()
  for (const match of matches) {
    const snippet = fits.get(match.ordinal)
    const fitted = snippet ? { ...match, snippet, complete: true } : match
    const key = paletteTranscriptTabKey(match.worktreeId, match.tabId, match.executionHostId)
    const previous = byTab.get(key)
    if (
      !previous ||
      (fitted.complete && !previous.complete) ||
      (fitted.complete === previous.complete && fitted.ordinal < previous.ordinal)
    ) {
      byTab.set(key, fitted)
    }
  }
  return [...byTab.values()].sort((a, b) => a.ordinal - b.ordinal)
}

/** Keeps ordinary evidence separate; the Cmd+J adapter chooses the stronger band. */
export function mergeWorkspaceTabTranscriptMatches({
  titleItems,
  entries,
  matches,
  context,
  isTranscriptWorktree,
  executionHostIdForWorktree,
  eligibleTabs
}: {
  titleItems: WorkspaceTabPaletteItem[]
  entries: readonly SearchableWorkspaceTab[]
  matches: readonly PaletteTranscriptMatch[]
  context: PaletteSearchContext
  /** Keeps transcript destinations within the currently searchable workspace scope. */
  isTranscriptWorktree: (worktree: Worktree) => boolean
  executionHostIdForWorktree?: (worktree: Worktree) => ExecutionHostId | null | undefined
  eligibleTabs: ReadonlySet<string>
}): {
  titleItems: WorkspaceTabPaletteItem[]
  transcriptOnlyItems: readonly WorkspaceTabPaletteItem[]
} {
  const entryByChatTab = new Map<string, SearchableWorkspaceTab>()
  for (const entry of entries) {
    if (
      (entry.tab.contentType !== 'terminal' && entry.tab.contentType !== 'agent-session') ||
      !isTranscriptWorktree(entry.worktree)
    ) {
      continue
    }
    const key = paletteTranscriptTabKey(
      entry.worktree.id,
      entry.tab.contentType === 'agent-session' ? entry.tab.id : entry.tab.entityId,
      entry.tab.executionHostId ??
        executionHostIdForWorktree?.(entry.worktree) ??
        entry.worktree.hostId ??
        LOCAL_EXECUTION_HOST_ID
    )
    if (!entryByChatTab.has(key)) {
      entryByChatTab.set(key, entry)
    }
  }
  const titleItemIds = new Set(titleItems.map((item) => item.id))
  const matchByItemId = new Map<string, PaletteTranscriptMatch>()
  const reservedItemIds = new Set<string>()
  for (const [key, entry] of entryByChatTab) {
    if (eligibleTabs.has(key)) {
      reservedItemIds.add(buildWorkspaceTabBaseResult(entry, context).paletteIdentity)
    }
  }
  const transcriptOnlyItems: WorkspaceTabPaletteItem[] = []
  for (const match of matches) {
    const entry = entryByChatTab.get(
      paletteTranscriptTabKey(match.worktreeId, match.tabId, match.executionHostId)
    )
    if (!entry) {
      continue
    }
    const result = buildWorkspaceTabBaseResult(entry, context)
    if (titleItemIds.has(result.paletteIdentity)) {
      matchByItemId.set(result.paletteIdentity, match)
      continue
    }
    transcriptOnlyItems.push({
      id: result.paletteIdentity,
      type: 'workspace-tab',
      result,
      transcript: { complete: match.complete, ordinal: match.ordinal },
      transcriptReserved: true,
      ...(match.snippet ? { transcriptSnippet: match.snippet } : {})
    })
  }
  return {
    titleItems:
      matchByItemId.size === 0 && reservedItemIds.size === 0
        ? titleItems
        : titleItems.map((item) => {
            const match = matchByItemId.get(item.id)
            return {
              ...item,
              transcriptReserved: reservedItemIds.has(item.id) || Boolean(match),
              ...(match
                ? {
                    transcript: { complete: match.complete, ordinal: match.ordinal },
                    ...(match.snippet ? { transcriptSnippet: match.snippet } : {})
                  }
                : {})
            }
          }),
    transcriptOnlyItems: transcriptOnlyItems.length ? transcriptOnlyItems : NO_WORKSPACE_TAB_ITEMS
  }
}
