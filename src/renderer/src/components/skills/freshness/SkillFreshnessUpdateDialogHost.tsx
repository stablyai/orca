import { Suspense, useSyncExternalStore } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import {
  getSkillFreshnessUpdateDialogOpenRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

const SkillFreshnessUpdateDialog = lazy(() =>
  import('./SkillFreshnessUpdateDialog').then((module) => ({
    default: module.SkillFreshnessUpdateDialog
  }))
)

export function SkillFreshnessUpdateDialogHost(): React.JSX.Element | null {
  const openRequest = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogOpenRequest,
    getSkillFreshnessUpdateDialogOpenRequest
  )
  if (openRequest === null) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <SkillFreshnessUpdateDialog />
    </Suspense>
  )
}
