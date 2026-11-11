// Home's arrangement state: groups from your synced prefs, plus the edits (pin, move, drag,
// collapse, section order) that save back to them.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  formatWorkspaceNumber,
  type CloudWorkspace
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  MAX_PINNED,
  arrangeCloudWorkspaces,
  dropOnto,
  moveSection,
  nudge,
  reorderGroup,
  setCollapsed,
  setPinned,
  type CloudWorkspaceGroup
} from '../../../../shared/cloud-workspaces/cloud-workspace-arrangement'
import {
  editCloudWorkspacePrefs,
  getCloudWorkspacePrefs,
  refreshCloudWorkspacePrefs,
  useCloudWorkspacePrefs
} from './cloud-workspace-prefs'
import type { GroupDrag } from './CloudWorkspaceGroup'
import type { RowArrangement } from './CloudWorkspaceRowMenu'

/** How a screen reader hears a workspace in move confirmations: its number, else its title. */
function spoken(w: CloudWorkspace | undefined): string {
  return w?.number ? formatWorkspaceNumber(w.number) : (w?.title ?? '')
}

function groupName(group: CloudWorkspaceGroup<CloudWorkspace>): string {
  return group.kind === 'pinned'
    ? translate('auto.components.cloudWorkspaces.pinned', 'Pinned')
    : (group.section ??
        translate('auto.components.cloudWorkspaces.otherWorkspaces', 'Other workspaces'))
}

export function useCloudWorkspaceArrangement(visible: readonly CloudWorkspace[]) {
  const prefs = useCloudWorkspacePrefs()
  // Drags and menu moves are confirmed politely for screen readers ("Moved W-12 to position 2 in Pinned").
  const [announcement, setAnnouncement] = useState('')
  // Opening Home is a good moment to pick up another device's edits without waiting for the poll.
  useEffect(() => {
    void refreshCloudWorkspacePrefs()
  }, [])
  const groups = useMemo(
    () => arrangeCloudWorkspaces(visible, prefs.document),
    [visible, prefs.document]
  )
  const groupOf = useCallback(
    (id: string): CloudWorkspaceGroup<CloudWorkspace> | undefined =>
      groups.find((group) => group.rows.some((w) => w.id === id)),
    [groups]
  )
  const reorder = useCallback(
    (group: CloudWorkspaceGroup<CloudWorkspace>, ids: string[] | null, movedId: string) => {
      if (!ids) {
        return
      }
      void editCloudWorkspacePrefs((doc) => reorderGroup(doc, group, ids))
      setAnnouncement(
        translate(
          'auto.components.cloudWorkspaces.movedTo',
          'Moved {{name}} to position {{position}} in {{group}}',
          {
            name: spoken(group.rows.find((w) => w.id === movedId)),
            position: ids.indexOf(movedId) + 1,
            group: groupName(group)
          }
        )
      )
    },
    []
  )

  const [dragging, setDragging] = useState<GroupDrag['dragging']>(null)
  const drag = useMemo<GroupDrag>(
    () => ({
      dragging,
      start: (id, group) => setDragging({ id, group }),
      end: () => setDragging(null),
      drop: (overId, groupKey) => {
        const group = groups.find((g) => g.key === groupKey)
        if (dragging && group) {
          reorder(
            group,
            dropOnto(
              group.rows.map((w) => w.id),
              dragging.id,
              overId
            ),
            dragging.id
          )
        }
        setDragging(null)
      }
    }),
    [dragging, groups, reorder]
  )

  const pin = useCallback((w: CloudWorkspace, pinned: boolean) => {
    if (pinned && getCloudWorkspacePrefs().document.pinned.length >= MAX_PINNED) {
      toast.error(
        translate(
          'auto.components.cloudWorkspaces.pinLimit',
          'You can pin up to {{count}} workspaces. Unpin one first.',
          { count: MAX_PINNED }
        )
      )
      return
    }
    void editCloudWorkspacePrefs((doc) => setPinned(doc, w.id, pinned))
    setAnnouncement(
      pinned
        ? translate('auto.components.cloudWorkspaces.pinnedName', 'Pinned {{name}}', {
            name: spoken(w)
          })
        : translate('auto.components.cloudWorkspaces.unpinnedName', 'Unpinned {{name}}', {
            name: spoken(w)
          })
    )
  }, [])

  const move = useCallback(
    (w: CloudWorkspace, delta: number) => {
      const group = groupOf(w.id)
      if (group) {
        reorder(
          group,
          nudge(
            group.rows.map((row) => row.id),
            w.id,
            delta
          ),
          w.id
        )
      }
    },
    [groupOf, reorder]
  )

  const shownSections = useMemo(
    () =>
      groups.flatMap((group) => (group.kind === 'section' && group.section ? [group.section] : [])),
    [groups]
  )
  const toggleCollapsed = useCallback((section: string, collapsed: boolean) => {
    void editCloudWorkspacePrefs((doc) => setCollapsed(doc, section, collapsed))
  }, [])
  const moveSectionBy = useCallback(
    (section: string, delta: number) => {
      void editCloudWorkspacePrefs((doc) => moveSection(doc, shownSections, section, delta) ?? doc)
    },
    [shownSections]
  )

  const arrangementFor = useCallback(
    (group: CloudWorkspaceGroup<CloudWorkspace>, index: number): RowArrangement => ({
      pinned: group.kind === 'pinned',
      canMoveUp: index > 0,
      canMoveDown: index < group.rows.length - 1
    }),
    []
  )

  return {
    announcement,
    groups,
    drag,
    pin,
    move,
    toggleCollapsed,
    moveSection: moveSectionBy,
    shownSections,
    arrangementFor
  }
}
