/**
 * The runtime's live layout as the oracle reads it: a `layout.subscribe` consumer's cache, applied
 * frame by frame, and the same layout as models for the model rules.
 */

import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../src/shared/execution-host'
import type {
  LayoutLeaf,
  LayoutTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from '../../../src/shared/workspace-layout/workspace-layout-model'
import type { PublishedWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-published'
import { applyWorkspaceLayoutRecordChange } from '../../../src/shared/workspace-layout/workspace-layout-records'
import {
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame
} from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'

/** One published workspace and the partition it belongs to. */
export type LiveWorkspace = {
  key: string
  hostId: ExecutionHostId
  layout: PublishedWorkspaceLayout
}

// A frame names no partition; a terminal tab runs on its partition, and only panes need one.
function partitionOf(layout: PublishedWorkspaceLayout): ExecutionHostId {
  return (
    layout.tabs.find((tab) => tab.kind === 'terminal')?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  )
}

export class LiveLayoutFeed {
  private workspaces = new Map<string, PublishedWorkspaceLayout>()
  /** False until the first snapshot frame, and again while a stream is reopened. */
  ready = false
  /** Frames applied so far; a step reads it to tell whether the runtime moved during a read. */
  frames = 0
  /** Why the stream failed, if it did; the step reports it. */
  error: string | null = null

  constructor(private readonly onFrame: (feed: LiveLayoutFeed) => void) {}

  /** Applies one `layout.subscribe` result; a malformed one is kept as a stream error. */
  apply(result: unknown): void {
    const frame = readWorkspaceLayoutStreamFrame(result)
    if (!frame) {
      this.fail(`unreadable layout frame: ${JSON.stringify(result)}`)
      return
    }
    if (frame.type === 'end') {
      this.ready = false
      return
    }
    try {
      this.applyChange(frame)
    } catch (error) {
      this.fail(`layout frame does not apply: ${String(error)}`)
      return
    }
    this.frames += 1
    this.onFrame(this)
  }

  private applyChange(frame: WorkspaceLayoutChangeFrame): void {
    switch (frame.type) {
      case 'snapshot':
        this.workspaces = new Map(frame.workspaces.map((entry) => [entry.key, entry.layout]))
        this.ready = true
        return
      case 'workspace':
        this.workspaces.set(frame.key, frame.layout)
        return
      case 'removed':
        this.workspaces.delete(frame.key)
        return
      case 'records':
        // A layout-owner host's one frame per operation: each workspace's changed records.
        for (const change of frame.workspaces) {
          const layout = applyWorkspaceLayoutRecordChange(this.workspaces.get(change.key), change)
          if (layout) {
            this.workspaces.set(change.key, layout)
          } else {
            this.workspaces.delete(change.key)
          }
        }
    }
  }

  fail(message: string): void {
    this.error = message
    this.ready = false
  }

  /** The stream is being reopened (relaunch, reload, serve restart); its snapshot replaces the cache. */
  reopening(): void {
    this.ready = false
    this.error = null
  }

  entries(): LiveWorkspace[] {
    return [...this.workspaces].map(([key, layout]) => ({
      key,
      hostId: partitionOf(layout),
      layout
    }))
  }
}

function toLayoutTab(tab: PublishedWorkspaceLayout['tabs'][number]): LayoutTab {
  const fields = {
    id: tab.id,
    entityId: tab.entityId,
    createdAt: tab.createdAt,
    customTitle: tab.customTitle,
    color: tab.color
  }
  if (tab.kind !== 'terminal') {
    return { ...fields, kind: tab.kind }
  }
  return {
    ...fields,
    kind: 'terminal',
    terminal: tab.terminal?.defaultTitle ? { defaultTitle: tab.terminal.defaultTitle } : {},
    panes: {
      root: tab.terminal?.root ?? null,
      ...(tab.terminal?.chatLeafId ? { chatLeafId: tab.terminal.chatLeafId } : {})
    }
  }
}

function toWorkspaceLayout(layout: PublishedWorkspaceLayout): WorkspaceLayout {
  const leaves: Record<string, LayoutLeaf> = {}
  for (const pane of layout.tabs.flatMap((tab) => tab.terminal?.panes ?? [])) {
    leaves[pane.leafId] = {
      ...(pane.ptyId ? { ptyId: pane.ptyId } : {}),
      ...(pane.title ? { title: pane.title } : {})
    }
  }
  return {
    worktreeId: layout.worktreeId,
    tabs: layout.tabs.map(toLayoutTab),
    groups: layout.groups.map((group) => ({ id: group.id, tabOrder: [...group.tabIds] })),
    ...(layout.groupLayout ? { groupLayout: layout.groupLayout } : {}),
    leaves
  }
}

/** The published workspaces as one model per partition, for the model rules. */
export function liveLayoutModels(entries: readonly LiveWorkspace[]): WorkspaceLayoutModel[] {
  const models = new Map<ExecutionHostId, WorkspaceLayoutModel>()
  for (const { key, hostId, layout } of entries) {
    const model = models.get(hostId) ?? {
      hostId,
      workspaces: {},
      records: {},
      legacy: { terminalRowOwners: {} }
    }
    model.workspaces[key] = toWorkspaceLayout(layout)
    models.set(hostId, model)
  }
  return [...models.values()]
}
