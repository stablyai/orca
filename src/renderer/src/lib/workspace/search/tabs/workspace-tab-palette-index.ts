import { shallow } from 'zustand/shallow'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { collectAgentMetadataFromIndex, getPaneKeyTabId } from './workspace-tab-agent-metadata'
import {
  buildPaletteTabDocument,
  type PaletteTabDocumentInput
} from '../../../../../../shared/palette-match/tab-document'
import type { PaletteDocument } from '../../../../../../shared/palette-match/palette-document'
import { buildSearchableWorkspaceTabEntries } from './workspace-tab-palette-entry-builder'
import { createWorkspaceTabAgentIndex } from './workspace-tab-agent-index'
import {
  findAmbiguousWorktreeIds,
  getUnifiedTabPaletteExecutionHostId
} from '../../ownership/unified-tab-host-ownership'
import { resolveOpenTabOccupantAgent } from '../../../agent-session/tab-identity/open-tab-occupant-agent'
import type {
  BuildSearchableWorkspaceTabsOptions,
  SearchableWorkspaceTab
} from './workspace-tab-search-types'

function entryIdentity(entry: SearchableWorkspaceTab): string {
  return JSON.stringify([
    getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ?? null,
    entry.tab.id
  ])
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

function stableEntryInputs({
  agentStatusByPaneKey: _agentStatusByPaneKey,
  sleepingAgentSessionsByPaneKey: _sleepingAgentSessionsByPaneKey,
  terminalLayoutsByTabId: _terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey: _paneForegroundAgentByPaneKey,
  ...inputs
}: BuildSearchableWorkspaceTabsOptions) {
  return inputs
}

/** One open palette owns the derived index; closing it drops every cached entry. */
export function createWorkspaceTabPaletteIndex() {
  const agents = createWorkspaceTabAgentIndex()
  let previous: BuildSearchableWorkspaceTabsOptions | undefined
  let entries: SearchableWorkspaceTab[] = []
  let documents = new Map<string, { input: PaletteTabDocumentInput; document: PaletteDocument }>()
  let terminalEntries = new Map<string, number[]>()
  let terminalTabs = new Map<string, Map<string, TerminalTab>>()
  let ambiguousWorktreeIds: ReadonlySet<string> = new Set()

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
    const statusOnly =
      previous &&
      Object.keys(options).length === Object.keys(previous).length &&
      shallow(stableEntryInputs(previous), stableEntryInputs(options))
    previous = options
    if (statusOnly && addressed && dirtyTabs !== null) {
      let next = entries
      for (const tabId of dirtyTabs) {
        for (const position of terminalEntries.get(tabId) ?? []) {
          const entry = entries[position]
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
          }
        }
      }
      entries = next
      return entries
    }
    const nextDocuments = new Map<
      string,
      { input: PaletteTabDocumentInput; document: PaletteDocument }
    >()
    const priorEntries = new Map(entries.map((entry) => [entryIdentity(entry), entry]))
    const next = buildSearchableWorkspaceTabEntries(options, {
      agentIndex: agents.index,
      document(identity, input) {
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
    }).map((entry) => {
      const prior = priorEntries.get(entryIdentity(entry))
      return prior && sameEntry(prior, entry) ? prior : entry
    })
    documents = nextDocuments
    ambiguousWorktreeIds = findAmbiguousWorktreeIds(options.ownershipWorktrees ?? options.worktrees)
    terminalEntries = new Map()
    terminalTabs = new Map()
    for (const worktree of options.worktrees) {
      if (!terminalTabs.has(worktree.id)) {
        terminalTabs.set(
          worktree.id,
          new Map((options.tabsByWorktree[worktree.id] ?? []).map((tab) => [tab.id, tab]))
        )
      }
    }
    next.forEach((entry, position) => {
      if (entry.tab.contentType !== 'terminal') {
        return
      }
      const positions = terminalEntries.get(entry.tab.entityId) ?? []
      positions.push(position)
      terminalEntries.set(entry.tab.entityId, positions)
    })
    if (!shallow(entries, next)) {
      entries = next
    }
    return entries
  }
}
