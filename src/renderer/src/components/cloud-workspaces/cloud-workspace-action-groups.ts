// One action set per cloud workspace, the same on every surface: the "Open cloud
// workspace…" list's ⋯ menu and the sidebar's context menu both render these groups, in this order:
// Open, Owner, Lifecycle, Danger. Each surface leaves out only what it already shows elsewhere (the
// sidebar row *is* the open workspace; the list has no local-only items) and never invents its own.
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  cloudLifecycleStateFromServer,
  cloudWorkspaceActions,
  type CloudLifecycleAction,
  type CloudLifecycleState
} from '@/lib/orca-cloud/cloud-lifecycle-actions'

/** The lifecycle actions the shared table decides; the rest (open, read, owner) are this list's own. */
const MATRIX_ACTIONS: ReadonlySet<string> = new Set([
  'wake',
  'sleep',
  'restart',
  'archive',
  'unarchive',
  'delete'
])

function isMatrixAction(
  action: CloudWorkspaceAction
): action is CloudWorkspaceAction & CloudLifecycleAction {
  return MATRIX_ACTIONS.has(action)
}

export type CloudWorkspaceAction =
  | 'open'
  | 'read'
  | 'wake'
  | 'reassignOwner'
  | 'restart'
  | 'sleep'
  | 'archive'
  | 'unarchive'
  | 'delete'

type CloudWorkspaceActionGroup = {
  id: 'open' | 'owner' | 'lifecycle' | 'danger'
  actions: CloudWorkspaceAction[]
}

export type CloudWorkspaceActionInput = Pick<CloudWorkspace, 'status' | 'archivedAt'> & {
  surface: 'list' | 'sidebar'
  canOpen: boolean
  canManage: boolean
  /** Asleep and readable without waking (the list reads the saved copy). */
  readableAsleep: boolean
  /** Restart needs this desktop's own runtime for it. */
  canRestart: boolean
  /** Teammates to hand it to (the list only). */
  hasMembers?: boolean
  /** The live state where the surface has one (the sidebar); else the record's server status. */
  lifecycleState?: CloudLifecycleState
}

export function cloudWorkspaceActionGroups(
  input: CloudWorkspaceActionInput
): CloudWorkspaceActionGroup[] {
  const list = input.surface === 'list'
  const archived = input.archivedAt !== null
  const open: CloudWorkspaceAction[] = []
  if (list && input.canOpen) {
    open.push(...(input.readableAsleep ? (['read', 'wake'] as const) : (['open'] as const)))
  }

  const owner: CloudWorkspaceAction[] =
    input.canManage && list && input.hasMembers ? ['reassignOwner'] : []

  const lifecycle: CloudWorkspaceAction[] = []
  if (input.canManage) {
    if (!archived && input.canRestart) {
      lifecycle.push('restart')
    }
    if (!archived) {
      lifecycle.push('sleep')
    }
    lifecycle.push(archived ? 'unarchive' : 'archive')
  }

  const danger: CloudWorkspaceAction[] = input.canManage ? ['delete'] : []

  // LIFECYCLE-MATRIX: what applies in this state, the same table every other surface reads.
  const matrix = cloudWorkspaceActions(
    input.lifecycleState ?? cloudLifecycleStateFromServer(input.status, input.archivedAt)
  )
  const applies = (action: CloudWorkspaceAction): boolean =>
    !isMatrixAction(action) || matrix.offers(action)

  return (
    [
      { id: 'open', actions: open },
      { id: 'owner', actions: owner },
      { id: 'lifecycle', actions: lifecycle.filter(applies) },
      { id: 'danger', actions: danger.filter(applies) }
    ] satisfies CloudWorkspaceActionGroup[]
  ).filter((group) => group.actions.length > 0)
}
