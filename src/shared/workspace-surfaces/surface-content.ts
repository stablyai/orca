import type { SurfaceExecutionProvenance } from './surface-execution-provenance'
import type { AgentType } from '../agent-status-types'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import type {
  LayoutLeaf,
  LayoutTab,
  LayoutTerminalCreation,
  LayoutTerminalTab,
  WorkspaceLayout
} from '../workspace-layout/workspace-layout-model'
import {
  collectLayoutLeafIdsInOrder,
  samePanesIgnoringRatios
} from '../workspace-layout/terminal-pane-tree'

export type SurfaceKey = { hostId: string; workspaceId: string; hostTabId: string }
export type SurfaceExpectation = { occurrence: string; revision?: number }
export type SurfaceLeaf = {
  occurrence: string
  /** Identifies an admitted start even before a process exists. */
  runId: string
  executorId?: string
  provenance?: SurfaceExecutionProvenance
  facts: Pick<LayoutLeaf, 'ptyId' | 'incarnationId' | 'sleeping' | 'resume'>
}
export type TerminalSurfaceContent = {
  kind: 'terminal'
  entityId: string
  creation: LayoutTerminalCreation
  root: TerminalPaneLayoutNode | null
  chatLeafId?: string
  leaves: Record<string, SurfaceLeaf>
}
export type ChatSurfaceContent = {
  kind: 'agent-session'
  sessionId: string
  agent: AgentType
}
export type SurfaceContent = TerminalSurfaceContent | ChatSurfaceContent
export type WorkspaceSurface = SurfaceKey & {
  occurrence: string
  revision: number
  createdAt: number
  content: SurfaceContent | null
}

export function retiredSurfacePtyIds(
  before: SurfaceContent | null | undefined,
  after: SurfaceContent | null
): string[] {
  if (before?.kind !== 'terminal') {
    return []
  }
  const kept = after?.kind === 'terminal' ? Object.values(after.leaves) : []
  return Object.values(before.leaves).flatMap((leaf) =>
    leaf.facts.ptyId &&
    !kept.some(
      (next) =>
        next.runId === leaf.runId &&
        next.facts.ptyId === leaf.facts.ptyId &&
        next.facts.incarnationId === leaf.facts.incarnationId
    )
      ? [leaf.facts.ptyId]
      : []
  )
}

/** Geometry belongs to each viewer; membership belongs to the execution host. */
export function surfacePaneTree(
  root: TerminalPaneLayoutNode | null
): TerminalPaneLayoutNode | null {
  if (!root || root.type === 'leaf') {
    return root
  }
  return {
    type: 'split',
    direction: root.direction,
    first: surfacePaneTree(root.first)!,
    second: surfacePaneTree(root.second)!
  }
}

function leafFacts(leaf: LayoutLeaf | undefined): SurfaceLeaf['facts'] {
  return {
    ...(leaf?.ptyId !== undefined ? { ptyId: leaf.ptyId } : {}),
    ...(leaf?.incarnationId !== undefined ? { incarnationId: leaf.incarnationId } : {}),
    ...(leaf?.sleeping !== undefined ? { sleeping: leaf.sleeping } : {}),
    ...(leaf?.resume !== undefined ? { resume: leaf.resume } : {})
  }
}

/** Extract only content after applying the existing layout reducer. */
export function surfaceContentOf(
  tab: LayoutTab,
  workspace: WorkspaceLayout,
  previous: SurfaceContent | null | undefined,
  mintId: () => string,
  movedLeaves: ReadonlyMap<string, SurfaceLeaf> = new Map(),
  newRuns: ReadonlySet<string> = new Set()
): SurfaceContent | null {
  if (tab.kind === 'agent-session' && tab.agentSessionAgent) {
    return { kind: 'agent-session', sessionId: tab.entityId, agent: tab.agentSessionAgent }
  }
  if (tab.kind !== 'terminal') {
    return null
  }
  const was = previous?.kind === 'terminal' ? previous : undefined
  const leaves: Record<string, SurfaceLeaf> = {}
  for (const leafId of collectLayoutLeafIdsInOrder(tab.panes.root)) {
    const prior = was?.leaves[leafId] ?? movedLeaves.get(leafId)
    leaves[leafId] = {
      occurrence: prior?.occurrence ?? mintId(),
      runId: prior && !newRuns.has(leafId) ? prior.runId : mintId(),
      ...(prior?.executorId &&
      !newRuns.has(leafId) &&
      prior.facts.ptyId === workspace.leaves?.[leafId]?.ptyId &&
      prior.facts.incarnationId === workspace.leaves?.[leafId]?.incarnationId
        ? {
            executorId: prior.executorId,
            ...(prior.provenance ? { provenance: prior.provenance } : {})
          }
        : {}),
      facts: leafFacts(workspace.leaves?.[leafId])
    }
  }
  return {
    kind: 'terminal',
    entityId: tab.entityId,
    creation: tab.terminal,
    root: surfacePaneTree(tab.panes.root),
    ...(tab.panes.chatLeafId ? { chatLeafId: tab.panes.chatLeafId } : {}),
    leaves
  }
}

/** Retain divider sizes only when they still describe the same membership. */
function treeWithViewRatios(
  root: TerminalPaneLayoutNode | null,
  view: TerminalPaneLayoutNode | null | undefined
): TerminalPaneLayoutNode | null {
  if (!root || root.type === 'leaf') {
    return root
  }
  return view && samePanesIgnoringRatios(root, view) ? view : root
}

export function surfaceLayoutTab(
  surface: WorkspaceSurface & { content: SurfaceContent },
  view?: LayoutTab
): LayoutTab {
  const { content } = surface
  const fields = {
    id: surface.hostTabId,
    entityId: content.kind === 'terminal' ? content.entityId : content.sessionId,
    createdAt: surface.createdAt,
    customTitle: null,
    color: null,
    ...(view
      ? {
          customTitle: view.customTitle,
          color: view.color,
          generatedTitle: view.generatedTitle,
          aiVaultTitle: view.aiVaultTitle,
          quickCommandLabel: view.quickCommandLabel,
          isPinned: view.isPinned,
          viewMode: view.viewMode
        }
      : {})
  }
  if (content.kind === 'agent-session') {
    return { ...fields, kind: 'agent-session', agentSessionAgent: content.agent }
  }
  return {
    ...fields,
    kind: 'terminal',
    terminal: content.creation,
    panes: {
      root: treeWithViewRatios(content.root, view?.kind === 'terminal' ? view.panes.root : null),
      ...(content.chatLeafId ? { chatLeafId: content.chatLeafId } : {})
    }
  } satisfies LayoutTerminalTab
}
