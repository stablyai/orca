import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import type { ActivityBarItem } from './activity-bar-buttons'

type ResolveRightSidebarEffectiveTabParams = {
  normalizedActiveTab: ActiveRightSidebarTab
  visibleItems: readonly Pick<ActivityBarItem, 'id'>[]
  activeFolderWorkspaceKey: string | null
  rememberedFolderTab: ActiveRightSidebarTab | null | undefined
}

export function resolveRightSidebarEffectiveTab({
  normalizedActiveTab,
  visibleItems,
  activeFolderWorkspaceKey,
  rememberedFolderTab
}: ResolveRightSidebarEffectiveTabParams): ActiveRightSidebarTab {
  if (visibleItems.length === 0) {
    throw new Error('Right sidebar activity items must include at least one visible tab')
  }

  const isVisible = (tab: ActiveRightSidebarTab): boolean =>
    visibleItems.some((item) => item.id === tab)

  if (activeFolderWorkspaceKey && rememberedFolderTab && isVisible(rememberedFolderTab)) {
    return rememberedFolderTab
  }

  if (isVisible(normalizedActiveTab)) {
    return normalizedActiveTab
  }

  return visibleItems[0].id
}
