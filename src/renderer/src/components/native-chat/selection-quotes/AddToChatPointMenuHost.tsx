import { Suspense, useSyncExternalStore } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { readPointMenu, subscribePointMenu } from './add-to-chat-point-menu'

const AddToChatPointMenu = lazy(() =>
  import('./AddToChatMenu').then((m) => ({ default: m.AddToChatPointMenu }))
)

export function AddToChatPointMenuHost(): React.JSX.Element | null {
  const menu = useSyncExternalStore(subscribePointMenu, readPointMenu)
  if (!menu) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <AddToChatPointMenu menu={menu} />
    </Suspense>
  )
}
