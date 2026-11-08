import { useEffect, useState } from 'react'
import { GitGraph } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSourceControlState } from '../panel/worktree-scope'
import {
  gitGraphScope,
  gitGraphSupport,
  gitGraphUpdateMessage,
  openGitGraph,
  probeGitGraphSupport
} from '@/lib/git-graph-tab'
import { useTranslate } from '@/i18n/use-translate'

export function GitGraphOpenButton({ worktreeId }: { worktreeId: string }) {
  const t = useTranslate()
  // Hidden section bodies stop these subscriptions; a primitive key keeps unrelated writes from rendering.
  const owner = useSourceControlState((state) =>
    JSON.stringify([worktreeId, gitGraphScope(worktreeId, state)?.route])
  )
  const status = useSourceControlState((state) => {
    const environmentId = gitGraphScope(worktreeId, state)?.route.runtimeEnvironmentId
    return environmentId ? state.runtimeStatusByEnvironmentId.get(environmentId) : undefined
  })
  const [probe, setProbe] = useState<{ owner: string; support: boolean | null }>()
  const support = probe?.owner === owner ? probe.support : null
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={support !== true}
            aria-label={t('gitGraph.title', 'Git Graph')}
            onClick={() => void openGitGraph(worktreeId)}
          >
            <GitGraph className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      {support !== null && (
        <TooltipContent>
          {support ? t('gitGraph.title', 'Git Graph') : gitGraphUpdateMessage(worktreeId, t)}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
