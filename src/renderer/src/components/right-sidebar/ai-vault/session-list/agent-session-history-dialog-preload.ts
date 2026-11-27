import { lazyWithPreload } from '@/app-shell/startup/lazy-with-retry'
import { usePreloadAfterInputQuiet } from '@/app-shell/startup/use-preload-after-input-quiet'

export const AiVaultSessionHistoryDialog = lazyWithPreload(
  () => import('./AiVaultSessionHistoryDialog')
)

/** Loads `/resume`'s Session History once a chat can open it, so its first open never suspends. */
export function usePreloadAgentSessionHistoryDialog(enabled: boolean): void {
  usePreloadAfterInputQuiet(AiVaultSessionHistoryDialog.preload, enabled)
}
