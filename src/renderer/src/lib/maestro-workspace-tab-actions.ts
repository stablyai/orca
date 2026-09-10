import type { TabContentType } from '../../../shared/tab-types'
import type { WorkspaceSurfaceId } from '../../../shared/maestro-workspace-canvas'

export type MaestroWorkspaceTabCreate = {
  kind: 'create'
  id: WorkspaceSurfaceId
  idempotencyKey: string
  contentType: Exclude<TabContentType, 'maestro'>
  groupId: string
}

export type MaestroWorkspaceTabAction =
  | MaestroWorkspaceTabCreate
  | { kind: 'focus'; id: WorkspaceSurfaceId }
  | { kind: 'rename'; id: WorkspaceSurfaceId; title: string }
  | { kind: 'move'; id: WorkspaceSurfaceId; groupId: string; index: number }
  | {
      kind: 'change'
      id: WorkspaceSurfaceId
      change: Readonly<Record<string, unknown>>
    }
  | { kind: 'close'; id: WorkspaceSurfaceId }

export type ExactWorkspaceTabAuthority<Result = unknown> = {
  create: (request: MaestroWorkspaceTabCreate) => Result | Promise<Result>
  focus: (id: WorkspaceSurfaceId) => Result | Promise<Result>
  rename: (id: WorkspaceSurfaceId, title: string) => Result | Promise<Result>
  move: (id: WorkspaceSurfaceId, groupId: string, index: number) => Result | Promise<Result>
  change: (
    id: WorkspaceSurfaceId,
    change: Readonly<Record<string, unknown>>
  ) => Result | Promise<Result>
  close: (id: WorkspaceSurfaceId) => Result | Promise<Result>
}

/** Routes Canvas commands solely by the host/workspace/unified-tab identity. */
export function runMaestroWorkspaceTabAction<Result>(
  authority: ExactWorkspaceTabAuthority<Result>,
  action: MaestroWorkspaceTabAction
): Result | Promise<Result> {
  switch (action.kind) {
    case 'create':
      return authority.create(action)
    case 'focus':
      return authority.focus(action.id)
    case 'rename':
      return authority.rename(action.id, action.title)
    case 'move':
      return authority.move(action.id, action.groupId, action.index)
    case 'change':
      return authority.change(action.id, action.change)
    case 'close':
      return authority.close(action.id)
  }
}
