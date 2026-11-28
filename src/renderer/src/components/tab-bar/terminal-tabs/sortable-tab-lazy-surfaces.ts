import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

export const LazySortableTabContextMenu = lazyWithRetry(
  () => import('./SortableTabContextMenu').then((m) => ({ default: m.SortableTabContextMenu })),
  { reloadKey: 'sortable-tab-context-menu' }
)

export const LazyNativeChatNamingErrorBlock = lazyWithRetry(
  () =>
    import('../session-actions/NativeChatNamingFailure').then((m) => ({
      default: m.NativeChatNamingErrorBlock
    })),
  { reloadKey: 'native-chat-naming-error-block' }
)

export const LazyNativeChatNamingFailedDialog = lazyWithRetry(
  () =>
    import('../session-actions/NativeChatNamingFailure').then((m) => ({
      default: m.NativeChatNamingFailedDialog
    })),
  { reloadKey: 'native-chat-naming-failed-dialog' }
)
