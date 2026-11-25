import { buildPaletteTabDocument } from '../../../../../../shared/palette-match/tab-document'
import type { PaletteTabDocumentInput } from '../../../../../../shared/palette-match/tab-document'
import type { PaletteDocument } from '../../../../../../shared/palette-match/palette-document'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { findAmbiguousWorktreeIds } from '../../ownership/unified-tab-host-ownership'
import {
  buildAgentMetadataTabIndex,
  type AgentMetadataTabIndex
} from './workspace-tab-agent-metadata'
import type { BuildSearchableWorkspaceTabsOptions } from './workspace-tab-search-types'

export type WorkspaceTabPaletteBuildContext = {
  agentIndex: AgentMetadataTabIndex
  document: (identity: string, input: PaletteTabDocumentInput) => PaletteDocument
}

/** Inputs every workspace's entries share; built once per pass. */
export type WorkspaceTabBuildScope = {
  openFilesById: Map<string, OpenFile[]>
  agentIndex: AgentMetadataTabIndex
  documentFor: (identity: string, input: PaletteTabDocumentInput) => PaletteDocument
  ambiguousWorktreeIds: ReadonlySet<string>
}

export function createWorkspaceTabBuildScope(
  {
    worktrees,
    ownershipWorktrees,
    openFiles,
    agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey
  }: BuildSearchableWorkspaceTabsOptions,
  context?: WorkspaceTabPaletteBuildContext
): WorkspaceTabBuildScope {
  const openFilesById = new Map<string, OpenFile[]>()
  for (const file of openFiles) {
    const bucket = openFilesById.get(file.id)
    if (bucket) {
      bucket.push(file)
    } else {
      openFilesById.set(file.id, [file])
    }
  }
  return {
    openFilesById,
    agentIndex:
      context?.agentIndex ??
      buildAgentMetadataTabIndex({
        agentStatusByPaneKey,
        sleepingAgentSessionsByPaneKey
      }),
    documentFor:
      context?.document ??
      ((_identity: string, input: PaletteTabDocumentInput) => buildPaletteTabDocument(input)),
    ambiguousWorktreeIds: findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)
  }
}
