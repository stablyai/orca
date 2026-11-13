import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { GitHubAccessHandoffPhase } from './use-github-access-handoff'

/**
 * REPO-ACCESS-REFRESH: under Project after "Add a GitHub repository…". While the list re-reads,
 * it says what it waits for; when the wait runs out it says nothing new came and offers one more
 * look, so the line never just vanishes (design-squad).
 */
export function GitHubHandoffLine({
  phase,
  onCheckAgain
}: {
  phase: Exclude<GitHubAccessHandoffPhase, 'idle'>
  onCheckAgain: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (phase === 'waiting') {
    return (
      <p role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        {t(
          'components.newWorkspace.cloudOnly.waitingForGitHubAccess',
          'Waiting for GitHub access…'
        )}
      </p>
    )
  }
  return (
    <div role="status" className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span>
        {t('components.newWorkspace.cloudOnly.noNewRepositoryYet', 'No new repository yet.')}
      </span>
      {/* statusAction pads its label by px-1, like the other links under Project. */}
      <Button type="button" variant="link" size="statusAction" onClick={onCheckAgain}>
        <span className="underline underline-offset-4">
          {t('components.newWorkspace.cloudOnly.checkAgain', 'Check again')}
        </span>
      </Button>
    </div>
  )
}
