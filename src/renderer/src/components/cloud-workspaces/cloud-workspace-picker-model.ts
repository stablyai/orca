// What "Open cloud workspace…" reads and lists for each focus. Pure, so the rules are tested apart
// from the dialog.
import type {
  CloudWorkspace,
  CloudWorkspaceListQuery
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { MemberDirectory } from './cloud-workspace-format'
import type { CloudWorkspacePickerFocus } from './cloud-workspace-picker-store'

export type CloudWorkspacePickerControls = {
  scope: 'mine' | 'team'
  archived: boolean
  search: string
}

export function initialPickerControls(hasOrg: boolean): CloudWorkspacePickerControls {
  // On a team, what you can't open from the sidebar is mostly what teammates shared.
  return { scope: hasOrg ? 'team' : 'mine', archived: false, search: '' }
}

/** Which controls the picker offers: a focused list (limit, teammate, team delete) is fixed. */
export function pickerShowsScope(focus: CloudWorkspacePickerFocus, hasOrg: boolean): boolean {
  return focus.kind === 'open' && hasOrg
}

export function pickerShowsArchived(focus: CloudWorkspacePickerFocus): boolean {
  return focus.kind === 'open' || focus.kind === 'teammate'
}

export function pickerListQuery(
  focus: CloudWorkspacePickerFocus,
  controls: CloudWorkspacePickerControls,
  hasOrg: boolean
): CloudWorkspaceListQuery {
  switch (focus.kind) {
    case 'open':
      return {
        scope: hasOrg ? controls.scope : 'mine',
        archived: controls.archived ? 'only' : 'exclude'
      }
    case 'teammate':
      return { scope: 'team', archived: controls.archived ? 'only' : 'exclude' }
    case 'running':
      return { scope: 'mine', archived: 'exclude' }
    case 'team-cleanup':
      return { scope: 'team', archived: 'include' }
  }
}

/** Only "Open" leaves out what the sidebar already shows; the other focuses are about acting on them. */
export function pickerHidesSidebarWorkspaces(focus: CloudWorkspacePickerFocus): boolean {
  return focus.kind === 'open'
}

function matchesSearch(w: CloudWorkspace, search: string, directory: MemberDirectory): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) {
    return true
  }
  const haystack = [
    w.title,
    w.repo?.url,
    w.repo?.branch,
    w.routineName,
    w.number ? formatWorkspaceNumber(w.number) : null,
    directory.get(w.ownerUserId)?.name,
    w.memberNames?.[w.ownerUserId]
  ]
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}

export function pickerRows({
  workspaces,
  focus,
  inSidebar,
  search,
  directory
}: {
  workspaces: readonly CloudWorkspace[]
  focus: CloudWorkspacePickerFocus
  inSidebar: ReadonlySet<string>
  search: string
  directory: MemberDirectory
}): { rows: CloudWorkspace[]; hiddenInSidebar: number } {
  let hiddenInSidebar = 0
  const rows: CloudWorkspace[] = []
  for (const w of workspaces) {
    if (
      focus.kind === 'teammate' &&
      w.ownerUserId !== focus.userId &&
      w.createdBy !== focus.userId
    ) {
      continue
    }
    if (focus.kind === 'running' && w.status !== 'running') {
      continue
    }
    if (pickerHidesSidebarWorkspaces(focus) && inSidebar.has(w.id)) {
      hiddenInSidebar += 1
      continue
    }
    if (matchesSearch(w, search, directory)) {
      rows.push(w)
    }
  }
  // Most recently active first: the one you are looking for is usually the one just used.
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { rows, hiddenInSidebar }
}
