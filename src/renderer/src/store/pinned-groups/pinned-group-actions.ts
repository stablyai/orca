import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import { PinnedGroupSchema } from '../../../../shared/pinned-groups'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

async function savePinnedGroups(updates: Partial<GlobalSettings>): Promise<void> {
  try {
    await useAppStore.getState().updateSettingsOrThrow(updates)
  } catch (error) {
    toast.error(
      translate('auto.components.sidebar.PinnedGroups.saveFailed', 'Failed to save pin groups')
    )
    throw error
  }
}

export async function createPinnedGroup(name: string, worktree: Worktree): Promise<void> {
  const settings = useAppStore.getState().settings
  const groups = settings?.pinnedGroups ?? []
  const group = PinnedGroupSchema.parse({
    id: createBrowserUuid(),
    name,
    order: Math.max(-1, ...groups.map((entry) => entry.order)) + 1
  })
  await savePinnedGroups({
    pinnedGroups: [...groups, group],
    pinnedGroupByWorktreeIdentity: {
      ...settings?.pinnedGroupByWorktreeIdentity,
      [getWorktreeHostIdentity(worktree)]: group.id
    }
  })
}

export async function assignPinnedGroup(worktree: Worktree, groupId: string | null): Promise<void> {
  const settings = useAppStore.getState().settings
  if (groupId !== null && !settings?.pinnedGroups?.some((group) => group.id === groupId)) {
    return
  }
  const membership = { ...settings?.pinnedGroupByWorktreeIdentity }
  const identity = getWorktreeHostIdentity(worktree)
  if (groupId === null) {
    delete membership[identity]
  } else {
    membership[identity] = groupId
  }
  await savePinnedGroups({ pinnedGroupByWorktreeIdentity: membership })
}

export async function renamePinnedGroup(groupId: string, name: string): Promise<void> {
  const groups = useAppStore.getState().settings?.pinnedGroups ?? []
  await savePinnedGroups({
    pinnedGroups: groups.map((group) =>
      group.id === groupId ? PinnedGroupSchema.parse({ ...group, name }) : group
    )
  })
}

export async function movePinnedGroup(groupId: string, direction: -1 | 1): Promise<void> {
  const groups = [...(useAppStore.getState().settings?.pinnedGroups ?? [])].sort(
    (a, b) => a.order - b.order
  )
  const index = groups.findIndex((group) => group.id === groupId)
  const next = index + direction
  if (index === -1 || next < 0 || next >= groups.length) {
    return
  }
  const group = groups[index]
  groups[index] = groups[next]
  groups[next] = group
  await savePinnedGroups({ pinnedGroups: groups.map((group, order) => ({ ...group, order })) })
}

export async function removePinnedGroup(groupId: string): Promise<void> {
  const settings = useAppStore.getState().settings
  await savePinnedGroups({
    pinnedGroups: (settings?.pinnedGroups ?? []).filter((group) => group.id !== groupId),
    pinnedGroupByWorktreeIdentity: Object.fromEntries(
      Object.entries(settings?.pinnedGroupByWorktreeIdentity ?? {}).filter(
        ([, id]) => id !== groupId
      )
    )
  })
}
