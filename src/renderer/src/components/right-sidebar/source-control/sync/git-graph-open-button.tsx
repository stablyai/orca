import { useEffect, useState } from 'react'
import { GitGraph } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSourceControlState } from '../panel/worktree-scope'
import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  gitGraphScope,
  gitGraphSupport,
  gitGraphUpdateMessage,
  openGitGraph,
  probeGitGraphSupport
} from '@/lib/source-control/graph/git-graph-tab'
import { toSourceControlRowOpenEvent, type SourceControlRowOpenEvent } from '../listing/split-open'
import { useTranslate } from '@/i18n/use-translate'

/** Whether this worktree's host can open Git Graph: null while the first probe runs. */
export function useGitGraphSupport(worktreeId: string): boolean | null {
  // Hidden section bodies stop these subscriptions; a primitive key keeps unrelated writes from rendering.
  const owner = useSourceControlState((state) =>
    JSON.stringify([worktreeId, gitGraphScope(worktreeId, state)?.route])
  )
  const status = useAppStateValueWithHostStatuses((state, statuses) => {
    const environmentId = gitGraphScope(worktreeId, state)?.route.runtimeEnvironmentId
    return environmentId ? statuses.get(environmentId) : undefined
  })
  const [probe, setProbe] = useState<{ owner: string; support: boolean | null }>()
  useEffect(() => {
    let current = true
    setProbe({ owner, support: gitGraphSupport(worktreeId) })
    void probeGitGraphSupport(worktreeId)
      .then((value) => {
        if (current) {
          setProbe({ owner, support: value })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [worktreeId, owner, status])
  return probe?.owner === owner ? probe.support : null
}

export function GitGraphOpenButton({
  worktreeId,
  onOpen
}: {
  worktreeId: string
  onOpen?: (event: SourceControlRowOpenEvent) => void
}) {
  const t = useTranslate()
  const support = useGitGraphSupport(worktreeId)
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={support !== true}
      data-testid="source-control-git-graph-button"
      onClick={(event) => {
        if (onOpen) {
          onOpen(toSourceControlRowOpenEvent(event))
          return
        }
        void openGitGraph(worktreeId)
      }}
    >
      <GitGraph className="size-3.5" />
      {t('auto.components.right.sidebar.SourceControl.gitGraphButton', 'Graph')}
    </Button>
  )
  if (support !== false) {
    return button
  }
  // Disabled buttons swallow pointer events, so the wrapper carries the explanation.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0" tabIndex={0}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{gitGraphUpdateMessage(worktreeId, t)}</TooltipContent>
    </Tooltip>
  )
}
