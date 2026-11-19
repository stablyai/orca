import { shallow } from 'zustand/shallow'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { collectAgentMetadataFromIndex, getPaneKeyTabId } from './workspace-tab-agent-metadata'
import {
  buildPaletteTabDocument,
  type PaletteTabDocumentInput
} from '../../../../../../shared/palette-match/tab-document'
import type { PaletteDocument } from '../../../../../../shared/palette-match/palette-document'
import { buildWorktreeTabEntries } from './workspace-tab-palette-entry-builder'
import {
  createWorkspaceTabBuildScope,
  type WorkspaceTabBuildScope
} from './workspace-tab-palette-build-scope'
import { createWorkspaceTabAgentIndex } from './workspace-tab-agent-index'
import { workspaceScopedChanges } from './workspace-tab-palette-change-scope'
import { getUnifiedTabPaletteExecutionHostId } from '../../ownership/unified-tab-host-ownership'
import { resolveOpenTabOccupantAgent } from '../../../agent-session/tab-identity/open-tab-occupant-agent'
import type {
  BuildSearchableWorkspaceTabsOptions,
  SearchableWorkspaceTab
} from './workspace-tab-search-types'

// Entries are immutable, so each one's identity is computed once.
const entryIdentities = new WeakMap<SearchableWorkspaceTab, string>()

function entryIdentity(entry: SearchableWorkspaceTab): string {
  let identity = entryIdentities.get(entry)
  if (identity === undefined) {
    identity = JSON.stringify([
      getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ?? null,
      entry.tab.id
    ])
    entryIdentities.set(entry, identity)
  }
  return identity
}

function sameEntry(a: SearchableWorkspaceTab, b: SearchableWorkspaceTab): boolean {
  return (
    shallow(a.agentMetadata, b.agentMetadata) &&
    shallow(a.secondarySearchTexts, b.secondarySearchTexts) &&
    shallow(a.typeSearchAliases, b.typeSearchAliases) &&
    shallow(
      { ...a, agentMetadata: null, secondarySearchTexts: null, typeSearchAliases: null },
      { ...b, agentMetadata: null, secondarySearchTexts: null, typeSearchAliases: null }
    )
  )
}

type PaletteDocumentCache = Map<
  string,
  { input: PaletteTabDocumentInput; document: PaletteDocument }
>

function cachedDocument(
  documents: PaletteDocumentCache,
  nextDocuments: PaletteDocumentCache,
  identity: string,
  input: PaletteTabDocumentInput
): PaletteDocument {
  const cached = documents.get(identity)
  const same =
    cached &&
    shallow(cached.input.secondaryTexts, input.secondaryTexts) &&
    shallow(cached.input.typeAliases, input.typeAliases) &&
    shallow(
      { ...cached.input, secondaryTexts: null, typeAliases: null },
      { ...input, secondaryTexts: null, typeAliases: null }
    )
  const value = same ? cached : { input, document: buildPaletteTabDocument(input) }
  nextDocuments.set(identity, value)
  return value.document
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** One open palette owns the derived index; closing it drops every cached entry. */
export function createWorkspaceTabPaletteIndex() {
  const agents = createWorkspaceTabAgentIndex()
  let previous: BuildSearchableWorkspaceTabsOptions | undefined
  let entries: SearchableWorkspaceTab[] = []
  // One segment per position in `worktrees`, each built on its own; flattening drops a tab an earlier segment listed.
  let segments: SearchableWorkspaceTab[][] = []
  // Each segment entry's position in `entries`, or -1 when an earlier segment listed the same tab.
  let flatPositions: number[][] = []
  // Every segment entry of a terminal, listed or not, so a status update keeps a hidden copy current too.
  let terminalEntries = new Map<string, [segment: number, offset: number][]>()
  let documents: PaletteDocumentCache = new Map()
  let terminalTabs = new Map<string, Map<string, TerminalTab>>()
  // Built by the last full pass; the workspace-scoped pass runs only while its inputs are unchanged.
  let scope: WorkspaceTabBuildScope | null = null

  const buildSegment = (
    options: BuildSearchableWorkspaceTabsOptions,
    buildScope: WorkspaceTabBuildScope,
    position: number,
    prior: ReadonlyMap<string, SearchableWorkspaceTab>
  ): SearchableWorkspaceTab[] => {
    const built: SearchableWorkspaceTab[] = []
    buildWorktreeTabEntries(options.worktrees[position], options, buildScope, new Set(), built)
    return built.map((entry) => {
      const before = prior.get(entryIdentity(entry))
      return before && sameEntry(before, entry) ? before : entry
    })
  }

  const indexTerminalTabs = (options: BuildSearchableWorkspaceTabsOptions, worktreeId: string) => {
    terminalTabs.set(
      worktreeId,
      new Map((options.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab]))
    )
  }

  const flatten = (): SearchableWorkspaceTab[] => {
    const next: SearchableWorkspaceTab[] = []
    const seen = new Set<string>()
    terminalEntries = new Map()
    flatPositions = segments.map((segment, segmentIndex) =>
      segment.map((entry, offset) => {
        if (entry.tab.contentType === 'terminal') {
          const located = terminalEntries.get(entry.tab.entityId) ?? []
          located.push([segmentIndex, offset])
          terminalEntries.set(entry.tab.entityId, located)
        }
        const identity = entryIdentity(entry)
        if (seen.has(identity)) {
          return -1
        }
        seen.add(identity)
        return next.push(entry) - 1
      })
    )
    return next
  }

  return (options: BuildSearchableWorkspaceTabsOptions): SearchableWorkspaceTab[] => {
    const agentTabs = agents.update(options)
    const dirtyTabs = agentTabs && new Set(agentTabs)
    let addressed = dirtyTabs !== null
    if (previous && dirtyTabs) {
      for (const [before, after, paneKeys] of [
        [previous.terminalLayoutsByTabId, options.terminalLayoutsByTabId, false],
        [previous.paneForegroundAgentByPaneKey, options.paneForegroundAgentByPaneKey, true]
      ] as const) {
        if (before === after) {
          continue
        }
        if (!before || !after) {
          addressed = false
          break
        }
        const changes = readRecordChanges(after, before)
        if (changes?.kind !== 'addressed') {
          addressed = false
          break
        }
        for (const key of changes.keys) {
          const tabId = paneKeys ? getPaneKeyTabId(key) : key
          if (tabId) {
            dirtyTabs.add(tabId)
          }
        }
      }
    }
    const changedWorkspaces = previous ? workspaceScopedChanges(previous, options) : null
    previous = options
    if (scope && changedWorkspaces && addressed && dirtyTabs !== null) {
      let next = entries
      if (changedWorkspaces.size > 0) {
        const partialScope: WorkspaceTabBuildScope = {
          ...scope,
          documentFor: (identity, input) => cachedDocument(documents, documents, identity, input)
        }
        let rebuilt = false
        options.worktrees.forEach((worktree, position) => {
          if (!changedWorkspaces.has(worktree.id)) {
            return
          }
          const before = segments[position]
          const prior = new Map(before.map((entry) => [entryIdentity(entry), entry]))
          const after = buildSegment(options, partialScope, position, prior)
          if (sameItems(before, after)) {
            return
          }
          const kept = new Set(after.map(entryIdentity))
          for (const identity of prior.keys()) {
            if (!kept.has(identity)) {
              documents.delete(identity)
            }
          }
          if (!rebuilt) {
            segments = segments.slice()
            rebuilt = true
          }
          segments[position] = after
        })
        for (const worktreeId of changedWorkspaces) {
          indexTerminalTabs(options, worktreeId)
        }
        if (rebuilt) {
          // A rebuilt workspace whose entries all stay hidden behind earlier copies keeps the published list.
          const flattened = flatten()
          if (!sameItems(entries, flattened)) {
            next = flattened
          }
        }
      }
      for (const tabId of dirtyTabs) {
        for (const [segmentIndex, offset] of terminalEntries.get(tabId) ?? []) {
          const entry = segments[segmentIndex][offset]
          const terminal = terminalTabs.get(entry.worktree.id)?.get(tabId)
          const updated = {
            ...entry,
            agentMetadata: collectAgentMetadataFromIndex(
              agents.index,
              tabId,
              entry.worktree,
              scope.ambiguousWorktreeIds
            ),
            occupantAgent: resolveOpenTabOccupantAgent({
              tabId,
              title: entry.title,
              defaultTitle: terminal?.defaultTitle,
              launchAgent: terminal?.launchAgent,
              layout: options.terminalLayoutsByTabId?.[tabId],
              agentStatusByPaneKey: options.agentStatusByPaneKey,
              sleepingAgentSessionsByPaneKey: options.sleepingAgentSessionsByPaneKey,
              paneForegroundAgentByPaneKey: options.paneForegroundAgentByPaneKey
            })
          }
          if (sameEntry(entry, updated)) {
            continue
          }
          segments[segmentIndex][offset] = updated
          const position = flatPositions[segmentIndex][offset]
          if (position >= 0) {
            if (next === entries) {
              next = entries.slice()
            }
            next[position] = updated
          }
        }
      }
      entries = next
      return entries
    }
    const nextDocuments: PaletteDocumentCache = new Map()
    scope = createWorkspaceTabBuildScope(options, {
      agentIndex: agents.index,
      document: (identity, input) => cachedDocument(documents, nextDocuments, identity, input)
    })
    const priorEntries = new Map(entries.map((entry) => [entryIdentity(entry), entry]))
    const fullScope = scope
    segments = options.worktrees.map((_worktree, position) =>
      buildSegment(options, fullScope, position, priorEntries)
    )
    documents = nextDocuments
    terminalTabs = new Map()
    for (const worktree of options.worktrees) {
      if (!terminalTabs.has(worktree.id)) {
        indexTerminalTabs(options, worktree.id)
      }
    }
    const next = flatten()
    if (!sameItems(entries, next)) {
      entries = next
    }
    return entries
  }
}
