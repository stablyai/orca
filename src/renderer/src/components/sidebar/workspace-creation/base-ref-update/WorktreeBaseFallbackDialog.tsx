import { Suspense, useSyncExternalStore } from 'react'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import {
  getWorktreeBaseFallbackNotice,
  subscribeWorktreeBaseFallbackNotice
} from './worktree-base-fallback-notice'

const WorktreeBaseFallbackDialogSurface = lazy(() => import('./WorktreeBaseFallbackDialogSurface'))

export default function WorktreeBaseFallbackDialog(): React.JSX.Element | null {
  const notice = useSyncExternalStore(
    subscribeWorktreeBaseFallbackNotice,
    getWorktreeBaseFallbackNotice,
    getWorktreeBaseFallbackNotice
  )
  const activeModal = useAppStore((state) => state.activeModal)
  const hasOpened = useLatchedOpen(notice !== null && activeModal === 'none')

  if (!hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <WorktreeBaseFallbackDialogSurface />
    </Suspense>
  )
}
