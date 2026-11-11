// One action set per cloud workspace, the same on every surface (JA-14): the Home list's ⋯ menu and
// the sidebar's context menu both render these groups, in this order: Open, Share, Lifecycle,
// Danger. Each surface leaves out only what it already shows elsewhere (the sidebar row *is* the
// open workspace; Home has no local-only items) and never invents its own.
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export type CloudWorkspaceAction =
  | 'open'
  | 'read'
  | 'wake'
  | 'copyLink'
  | 'copyWorkspaceLink'
  | 'share'
  | 'makePrivate'
  | 'reassignOwner'
  | 'moveToSection'
  | 'restart'
  | 'sleep'
  | 'archive'
  | 'unarchive'
  | 'delete'

export type CloudWorkspaceActionGroup = {
  id: 'open' | 'share' | 'lifecycle' | 'danger'
  actions: CloudWorkspaceAction[]
}

export type CloudWorkspaceActionInput = Pick<
  CloudWorkspace,
  'status' | 'archivedAt' | 'visibility'
> & {
  surface: 'home' | 'sidebar'
  canOpen: boolean
  canManage: boolean
  /** Asleep and readable without waking (Home reads the saved copy). */
  readableAsleep: boolean
  /** Restart needs this desktop's own runtime for it. */
  canRestart: boolean
  /** Teammates to hand it to (Home only). */
  hasMembers?: boolean
}

export function cloudWorkspaceActionGroups(
  input: CloudWorkspaceActionInput
): CloudWorkspaceActionGroup[] {
  const home = input.surface === 'home'
  const archived = input.archivedAt !== null
  const open: CloudWorkspaceAction[] = []
  if (home && input.canOpen) {
    open.push(...(input.readableAsleep ? (['read', 'wake'] as const) : (['open'] as const)))
  }
  if (home) {
    open.push('copyLink')
  }
  open.push('copyWorkspaceLink')

  const share: CloudWorkspaceAction[] = []
  if (input.canManage) {
    share.push(input.visibility === 'private' ? 'share' : 'makePrivate')
    if (home && input.hasMembers) {
      share.push('reassignOwner')
    }
    if (home) {
      share.push('moveToSection')
    }
  }

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
      { id: 'share', actions: share },
      { id: 'lifecycle', actions: lifecycle },
      { id: 'danger', actions: danger }
    ] satisfies CloudWorkspaceActionGroup[]
  ).filter((group) => group.actions.length > 0)
}
