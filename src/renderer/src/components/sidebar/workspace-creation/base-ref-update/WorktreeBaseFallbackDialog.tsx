import { Suspense, useState, useSyncExternalStore } from 'react'
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
  const open = notice !== null && activeModal === 'none'
  const [hasOpened, setHasOpened] = useState(open)

  if (open && !hasOpened) {
    setHasOpened(true)
  }

  if (!hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <WorktreeBaseFallbackDialogSurface />
    </Suspense>
  )
}
