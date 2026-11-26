import { useAppStore } from '@/store/index'

/** The server profile its latest page snapshot reports; null until then (Default). */
export function useServerBrowserPageProfileId(browserPageId: string): string | null {
  return useAppStore(
    (s) => s.remoteBrowserPageHandlesByPageId[browserPageId]?.browserProfileId ?? null
  )
}
