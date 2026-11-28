import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

export const LazyEditorFileTabContextMenu = lazyWithRetry(
  () => import('./EditorFileTabContextMenu').then((m) => ({ default: m.EditorFileTabContextMenu })),
  { reloadKey: 'editor-file-tab-context-menu' }
)
