import { memo } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { isFolderRepo } from '../../../../shared/repo-kind'

const SourceControl = lazy(() => import('./SourceControl'))

function SourceControlGateInner(): React.JSX.Element | null {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)

  if (!activeWorktree || !activeRepo || !activeWorktree.path) {
    return (
      <SourceControlUnavailableState>
        {translate(
          'auto.components.right.sidebar.SourceControl.c07b236287',
          'Select a workspace to view changes'
        )}
      </SourceControlUnavailableState>
    )
  }

  if (isFolderRepo(activeRepo)) {
    return (
      <SourceControlUnavailableState>
        {translate(
          'auto.components.right.sidebar.SourceControl.e131cd7128',
          'Source Control is only available for Git repositories'
        )}
      </SourceControlUnavailableState>
    )
  }

  return <SourceControl />
}

function SourceControlUnavailableState({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
      {children}
    </div>
  )
}

export default memo(SourceControlGateInner)
