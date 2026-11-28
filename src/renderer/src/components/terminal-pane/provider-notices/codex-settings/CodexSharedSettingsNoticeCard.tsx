import { Suspense } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'

const LazyCodexSharedSettingsNoticeCardBody = lazyWithRetry(
  () =>
    import('./CodexSharedSettingsNoticeCardBody').then((module) => ({
      default: module.CodexSharedSettingsNoticeCardBody
    })),
  { reloadKey: 'codex-shared-settings-notice-card-body' }
)

/** A persistent one-time notice, so it sits with the other cards rather than as a sticky toast. */
export function CodexSharedSettingsNoticeCard(): React.JSX.Element | null {
  const { visible, dismiss } = useCodexSharedSettingsNotice()
  if (!visible) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <LazyCodexSharedSettingsNoticeCardBody onDismiss={dismiss} />
    </Suspense>
  )
}
