// One action set per cloud workspace, the same on every surface: the "Open cloud
// workspace…" list's ⋯ menu and the sidebar's context menu both render these groups, in this order:
// Open, Owner, Lifecycle, Danger. Each surface leaves out only what it already shows elsewhere (the
// sidebar row *is* the open workspace; the list has no local-only items) and never invents its own.
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

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
    if (!archived && input.status === 'running') {
      lifecycle.push('sleep')
    }
    lifecycle.push(archived ? 'unarchive' : 'archive')
  }

  const danger: CloudWorkspaceAction[] = input.canManage ? ['delete'] : []

  return (
    [
      { id: 'open', actions: open },
      { id: 'owner', actions: owner },
      { id: 'lifecycle', actions: lifecycle },
      { id: 'danger', actions: danger }
    ] satisfies CloudWorkspaceActionGroup[]
  ).filter((group) => group.actions.length > 0)
}
