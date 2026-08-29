import { useAppStore } from '@/store'

export function browserPageExists(tabId: string): boolean {
  return Object.values(useAppStore.getState().browserPagesByWorkspace).some((pages) =>
    pages.some((page) => page.id === tabId)
  )
}
