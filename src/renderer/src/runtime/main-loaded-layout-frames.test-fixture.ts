// Feed switch-on tests main’s loaded partition frames instead of the window’s own restore.

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  diffPublishedLayouts,
  indexPublishedLayout
} from '../../../shared/workspace-layout/workspace-layout-records'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

/** The model main loads from one stored partition, with the ids it mints at load. */
export function loadMainLayoutModel(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): WorkspaceLayoutModel {
  return loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()).layout
}

/** What main publishes for each workspace of a model, by workspace key. */
export function publishedLayoutsOf(
  model: WorkspaceLayoutModel
): Record<string, PublishedWorkspaceLayout> {
  return Object.fromEntries(
    Object.entries(model.workspaces).map(([key, workspace]) => [
      key,
      publishWorkspaceLayout(workspace, model.hostId)
    ])
  )
}

/** What main publishes for one stored partition, by workspace key. */
export function mainLoadedLayouts(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): Record<string, PublishedWorkspaceLayout> {
  return publishedLayoutsOf(loadMainLayoutModel(hostId, session))
}

/** The snapshot frame a stream opens with. */
export function layoutSnapshotFrame(
  layouts: Record<string, PublishedWorkspaceLayout>,
  seq?: number
): WorkspaceLayoutChangeFrame {
  return {
    type: 'snapshot',
    workspaces: Object.entries(layouts).map(([key, layout]) => ({ key, layout })),
    ...(seq === undefined ? {} : { seq })
  }
}

/**
 * Main's frames as a layout-owner host sends them: a snapshot, then for each later layout one
 * records frame of the records that changed since the layout it last sent for that workspace.
 */
export function mainLayoutFrameSender(): {
  snapshot: (
    layouts: Record<string, PublishedWorkspaceLayout>,
    seq?: number
  ) => WorkspaceLayoutChangeFrame
  records: (
    key: string,
    layout: PublishedWorkspaceLayout,
    seq?: number
  ) => WorkspaceLayoutChangeFrame
} {
  let sent = new Map<string, PublishedWorkspaceLayout>()
  let position = 0
  return {
    snapshot: (layouts, seq) => {
      sent = new Map(Object.entries(layouts).map(([key, layout]) => [key, structuredClone(layout)]))
      position = seq ?? position
      return layoutSnapshotFrame(layouts, seq)
    },
    records: (key, layout, seq) => {
      const before = sent.get(key)
      sent.set(key, structuredClone(layout))
      position = seq ?? position + 1
      const change = before
        ? diffPublishedLayouts(
            key,
            indexPublishedLayout(before),
            indexPublishedLayout(layout),
            layout
          )
        : { key, change: 'layout' as const, layout }
      return {
        type: 'records',
        epoch: 'main-epoch',
        seq: position,
        workspaces: change ? [change] : []
      }
    }
  }
}
