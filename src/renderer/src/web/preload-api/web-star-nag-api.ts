import type { PreloadApi } from '../../../../preload/api-types'
import { noopUnsubscribe } from './web-storage'

export function createWebStarNagApi(): Partial<PreloadApi> {
  return {
    starNag: {
      onShow: () => noopUnsubscribe,
      onHide: () => noopUnsubscribe,
      dismiss: () => Promise.resolve(),
      later: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      openWeb: () => Promise.resolve(),
      starOrca: () => Promise.resolve(false),
      forceShow: () => Promise.resolve(),
      agentValueMoment: () => Promise.resolve({ status: 'skipped' }),
      showAgentValueMoment: () => Promise.resolve(),
      onboardingCompleted: () => Promise.resolve()
    }
  }
}
