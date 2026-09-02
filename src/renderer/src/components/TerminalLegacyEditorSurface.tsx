import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import type { TerminalController } from './use-terminal-controller'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

export function TerminalLegacyEditorSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const { activeTabType, renderedActiveWorktreeId, worktreeFiles } = controller
  if (!renderedActiveWorktreeId || activeTabType !== 'editor' || worktreeFiles.length === 0) {
    return null
  }
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {translate('auto.components.Terminal.5c1d2a32bb', 'Loading editor...')}
        </div>
      }
    >
      <EditorPanel />
    </Suspense>
  )
}
