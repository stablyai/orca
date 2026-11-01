import type { PreloadApi } from '../../../../preload/api-types'
import { parseOrchestrationDeepLink } from '../../../../shared/orchestration-deep-link'
import { noopUnsubscribe } from './web-storage'

type WebOrchestrationDeepLinkApi = Pick<
  NonNullable<Partial<PreloadApi>['ui']>,
  'onOpenOrchestrationDeepLink' | 'consumePendingOrchestrationDeepLink'
>

let initialBrowserOrchestrationDeepLink =
  typeof window !== 'undefined' ? parseOrchestrationDeepLink(window.location.href) : null
let initialBrowserOrchestrationDeepLinkConsumed = false

export function createWebOrchestrationDeepLinkApi(): WebOrchestrationDeepLinkApi {
  return {
    onOpenOrchestrationDeepLink: (callback) => {
      if (typeof window === 'undefined') {
        return noopUnsubscribe
      }
      const handlePopState = () => {
        const link = parseOrchestrationDeepLink(window.location.href)
        if (link) {
          callback(link)
        }
      }
      window.addEventListener('popstate', handlePopState)
      return () => window.removeEventListener('popstate', handlePopState)
    },
    consumePendingOrchestrationDeepLink: () => {
      if (initialBrowserOrchestrationDeepLinkConsumed) {
        return Promise.resolve(null)
      }
      initialBrowserOrchestrationDeepLinkConsumed = true
      const pending =
        initialBrowserOrchestrationDeepLink ??
        (typeof window !== 'undefined' ? parseOrchestrationDeepLink(window.location.href) : null)
      initialBrowserOrchestrationDeepLink = null
      return Promise.resolve(pending)
    }
  }
}
