import type { PreloadApi } from '../../../../preload/api-types'
import { parseWorktreeDeepLink } from '../../../../shared/worktree-deep-link'
import { noopUnsubscribe } from './web-storage'

type WebWorktreeDeepLinkApi = Pick<
  NonNullable<Partial<PreloadApi>['ui']>,
  'onOpenWorktreeDeepLink' | 'consumePendingWorktreeDeepLink'
>

let initialBrowserWorktreeDeepLink =
  typeof window !== 'undefined' ? parseWorktreeDeepLink(window.location.href) : null
let initialBrowserWorktreeDeepLinkConsumed = false

export function createWebWorktreeDeepLinkApi(): WebWorktreeDeepLinkApi {
  return {
    onOpenWorktreeDeepLink: (callback) => {
      if (typeof window === 'undefined') {
        return noopUnsubscribe
      }
      const handlePopState = () => {
        const link = parseWorktreeDeepLink(window.location.href)
        if (link) {
          callback(link)
        }
      }
      window.addEventListener('popstate', handlePopState)
      return () => window.removeEventListener('popstate', handlePopState)
    },
    consumePendingWorktreeDeepLink: () => {
      if (initialBrowserWorktreeDeepLinkConsumed) {
        return Promise.resolve(null)
      }
      initialBrowserWorktreeDeepLinkConsumed = true
      const pending =
        initialBrowserWorktreeDeepLink ??
        (typeof window !== 'undefined' ? parseWorktreeDeepLink(window.location.href) : null)
      initialBrowserWorktreeDeepLink = null
      return Promise.resolve(pending)
    }
  }
}
