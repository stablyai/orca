import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  beginDesktopNavigation as beginRequest,
  navigateDesktopTab as navigateTab,
  navigateDesktopGroup as navigateGroup,
  type DesktopNavigationRequest
} from './desktop-navigation-request'
export {
  captureDesktopNavigation,
  presentDesktopWorkspace,
  canPresentDesktopNavigation,
  commitDesktopNavigation,
  type DesktopNavigationRequest
} from './desktop-navigation-request'

export function beginDesktopNavigation(
  state: AppState = useAppStore.getState(),
  destinationIsExperimental = false
): DesktopNavigationRequest {
  return beginRequest(state, destinationIsExperimental)
}
export function navigateDesktopTab(
  tabId: string,
  options?: Parameters<typeof navigateTab>[2]
): boolean {
  return navigateTab(useAppStore.getState(), tabId, options)
}
export function navigateDesktopGroup(worktreeId: string, groupId: string): boolean {
  return navigateGroup(useAppStore.getState(), worktreeId, groupId)
}
