import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoBackedTaskSourceProvider } from '../../../../shared/task-source-repo-host-match'

/**
 * Selected repos a source never queried because their origin is on the other forge.
 * Why collapsed and without Retry: a retry cannot change the answer (#16473).
 */
export function TaskPageSkippedReposNotice({
  provider,
  repos
}: {
  provider: RepoBackedTaskSourceProvider
  repos: readonly Repo[]
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (repos.length === 0) {
    return null
  }
  const summary =
    provider === 'github'
      ? translate(
          'auto.components.TaskPage.skippedReposHostedOnGitLab',
          'Skipped — hosted on GitLab ({{value0}})',
          { value0: repos.length }
        )
      : translate(
          'auto.components.TaskPage.skippedReposHostedOnGitHub',
          'Skipped — hosted on GitHub ({{value0}})',
          { value0: repos.length }
        )
  return (
    <div className="border-b border-border/50 px-2.5 py-1 text-muted-foreground">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="xs">
            {open ? <ChevronDown /> : <ChevronRight />}
            {summary}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 pb-1.5 pl-5.5 pt-0.5 font-mono text-xs">
            {repos.map((repo) => (
              <li key={repo.id}>{repo.displayName || repo.path}</li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
