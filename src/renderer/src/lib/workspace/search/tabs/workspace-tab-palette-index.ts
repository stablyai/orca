import { shallow } from 'zustand/shallow'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { collectAgentMetadataFromIndex, getPaneKeyTabId } from './workspace-tab-agent-metadata'
import {
  buildPaletteTabDocument,
  type PaletteTabDocumentInput
} from '../../../../../../shared/palette-match/tab-document'
import type { PaletteDocument } from '../../../../../../shared/palette-match/palette-document'
import {
  buildWorktreeTabEntries,
  createWorkspaceTabBuildScope,
  type WorkspaceTabBuildScope
} from './workspace-tab-palette-entry-builder'
import { createWorkspaceTabAgentIndex } from './workspace-tab-agent-index'
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

// Records keyed by workspace id; a change to one workspace's value rebuilds only its entries.
const WORKSPACE_KEYED_INPUTS = [
  'unifiedTabsByWorktree',
  'tabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree'
] as const

function stableEntryInputs({
  agentStatusByPaneKey: _agentStatusByPaneKey,
  sleepingAgentSessionsByPaneKey: _sleepingAgentSessionsByPaneKey,
  terminalLayoutsByTabId: _terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey: _paneForegroundAgentByPaneKey,
  unifiedTabsByWorktree: _unifiedTabsByWorktree,
  tabsByWorktree: _tabsByWorktree,
  groupsByWorktree: _groupsByWorktree,
  activeGroupIdByWorktree: _activeGroupIdByWorktree,
  activeTabIdByWorktree: _activeTabIdByWorktree,
  activeFileIdByWorktree: _activeFileIdByWorktree,
  activeTabTypeByWorktree: _activeTabTypeByWorktree,
  ...inputs
}: BuildSearchableWorkspaceTabsOptions) {
  return inputs
}

/** Workspace ids whose keyed inputs changed; a record compare costs one identity check per workspace. */
function changedWorkspaceIds(
  previous: BuildSearchableWorkspaceTabsOptions,
  options: BuildSearchableWorkspaceTabsOptions
): Set<string> {
  const changed = new Set<string>()
  for (const field of WORKSPACE_KEYED_INPUTS) {
    const before: Record<string, unknown> = previous[field]
    const after: Record<string, unknown> = options[field]
    if (before === after) {
      continue
    }
    for (const id in after) {
      if (after[id] !== before[id]) {
        changed.add(id)
      }
    }
    for (const id in before) {
      if (!(id in after)) {
        changed.add(id)
      }
    }
  }
  return changed
}

type PaletteDocumentCache = Map<string, { input: PaletteTabDocumentInput; document: PaletteDocument }>

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

/** One open palette owns the derived index; closing it drops every cached entry. */
export function createWorkspaceTabPaletteIndex() {
  const agents = createWorkspaceTabAgentIndex()
  let previous: BuildSearchableWorkspaceTabsOptions | undefined
  let entries: SearchableWorkspaceTab[] = []
  // One segment per position in `worktrees`, each built on its own; flattening drops a tab an earlier segment listed.
  let segments: SearchableWorkspaceTab[][] = []
  let documents: PaletteDocumentCache = new Map()
  let terminalEntries = new Map<string, number[]>()
  // Where each flat entry lives: segment and offset, so a status update reaches both.
  let origins: [number, number][] = []
  let terminalTabs = new Map<string, Map<string, TerminalTab>>()
  let ambiguousWorktreeIds: ReadonlySet<string> = new Set()

  const rebuildSegment = (
    options: BuildSearchableWorkspaceTabsOptions,
    scope: WorkspaceTabBuildScope,
    position: number
  ): SearchableWorkspaceTab[] => {
    const prior = new Map((segments[position] ?? []).map((entry) => [entryIdentity(entry), entry]))
    const built: SearchableWorkspaceTab[] = []
    buildWorktreeTabEntries(options.worktrees[position], options, scope, new Set(), built)
    return built.map((entry) => {
      const before = prior.get(entryIdentity(entry))
      return before && sameEntry(before, entry) ? before : entry
    })
  }

  const indexTerminals = (
    options: BuildSearchableWorkspaceTabsOptions,
    next: SearchableWorkspaceTab[],
    worktreeIds: Iterable<string>
  ) => {
    for (const worktreeId of worktreeIds) {
      terminalTabs.set(
        worktreeId,
        new Map((options.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab]))
      )
    }
    terminalEntries = new Map()
    next.forEach((entry, position) => {
      if (entry.tab.contentType !== 'terminal') {
        return
      }
      const positions = terminalEntries.get(entry.tab.entityId) ?? []
      positions.push(position)
      terminalEntries.set(entry.tab.entityId, positions)
    })
  }

  const flatten = (): SearchableWorkspaceTab[] => {
    const next: SearchableWorkspaceTab[] = []
    const seen = new Set<string>()
    origins = []
    segments.forEach((segment, segmentIndex) => {
      segment.forEach((entry, offset) => {
        const identity = entryIdentity(entry)
        if (!seen.has(identity)) {
          seen.add(identity)
          next.push(entry)
          origins.push([segmentIndex, offset])
        }
      })
    })
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
    const workspaceScoped =
      previous &&
      Object.keys(options).length === Object.keys(previous).length &&
      shallow(stableEntryInputs(previous), stableEntryInputs(options))
    const changedWorkspaces = workspaceScoped && previous ? changedWorkspaceIds(previous, options) : null
    previous = options
    if (changedWorkspaces && addressed && dirtyTabs !== null) {
      let next = entries
      if (changedWorkspaces.size > 0) {
        const scope = createWorkspaceTabBuildScope(options, {
          agentIndex: agents.index,
          document: (identity, input) => cachedDocument(documents, documents, identity, input)
        })
        segments = segments.slice()
        options.worktrees.forEach((worktree, position) => {
          if (changedWorkspaces.has(worktree.id)) {
            const before = segments[position] ?? []
            const after = rebuildSegment(options, scope, position)
            const kept = new Set(after.map(entryIdentity))
            for (const entry of before) {
              const identity = entryIdentity(entry)
              if (!kept.has(identity)) {
                documents.delete(identity)
              }
            }
            segments[position] = after
          }
        })
        next = flatten()
        indexTerminals(options, next, changedWorkspaces)
      }
      for (const tabId of dirtyTabs) {
        for (const position of terminalEntries.get(tabId) ?? []) {
          const entry = next[position]
          const terminal = terminalTabs.get(entry.worktree.id)?.get(tabId)
          const updated = {
            ...entry,
            agentMetadata: collectAgentMetadataFromIndex(
              agents.index,
              tabId,
              entry.worktree,
              ambiguousWorktreeIds
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
          if (!sameEntry(entry, updated)) {
            if (next === entries) {
              next = entries.slice()
            }
            next[position] = updated
            const [segmentIndex, offset] = origins[position]
            segments[segmentIndex][offset] = updated
          }
        }
      }
      if (!shallow(entries, next)) {
        entries = next
      }
      return entries
    }
    const nextDocuments: PaletteDocumentCache = new Map()
    const scope = createWorkspaceTabBuildScope(options, {
      agentIndex: agents.index,
      document: (identity, input) => cachedDocument(documents, nextDocuments, identity, input)
    })
    const priorEntries = new Map(entries.map((entry) => [entryIdentity(entry), entry]))
    segments = options.worktrees.map((worktree) => {
      const built: SearchableWorkspaceTab[] = []
      buildWorktreeTabEntries(worktree, options, scope, new Set(), built)
      return built.map((entry) => {
        const prior = priorEntries.get(entryIdentity(entry))
        return prior && sameEntry(prior, entry) ? prior : entry
      })
    })
    documents = nextDocuments
    ambiguousWorktreeIds = scope.ambiguousWorktreeIds
    terminalTabs = new Map()
    const next = flatten()
    indexTerminals(
      options,
      next,
      options.worktrees.map((worktree) => worktree.id)
    )
    if (!shallow(entries, next)) {
      entries = next
    }
    return entries
  }
}
