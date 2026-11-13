import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useTranslate } from '@/i18n/use-translate'
import type { TerminalController } from './use-terminal-controller'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

export function TerminalLegacyEditorSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const t = useTranslate()
  const { activeTabType, renderedActiveWorktreeId, worktreeFiles } = controller
  if (!renderedActiveWorktreeId || activeTabType !== 'editor' || worktreeFiles.length === 0) {
    return null
  }
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {t('auto.components.Terminal.5c1d2a32bb', 'Loading editor...')}
        </div>
      }
    >
      <EditorPanel />
    </Suspense>
  )
}
