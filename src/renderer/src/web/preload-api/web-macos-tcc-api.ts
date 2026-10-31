import type { PreloadApi } from '../../../../preload/api-types'
import { noopUnsubscribe } from './web-storage'

export function createMacosTccPromptsApi(): NonNullable<Partial<PreloadApi>['macosTccPrompts']> {
  // Why: TCC is a macOS-desktop concept; the web client has no log stream to watch.
  return {
    onThreshold: () => noopUnsubscribe,
    consumePending: () => Promise.resolve(null),
    acknowledgePending: () => Promise.resolve(),
    releasePending: () => Promise.resolve(),
    dismiss: () => Promise.resolve()
  }
}
