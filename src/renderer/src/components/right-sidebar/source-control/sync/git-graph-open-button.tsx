import { useEffect, useState } from 'react'
import { GitGraph } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  gitGraphScope,
  gitGraphSupport,
  gitGraphUpdateMessage,
  openGitGraph,
  probeGitGraphSupport
} from '@/lib/git-graph-tab'
import { translate } from '@/i18n/i18n'

export function GitGraphOpenButton({ worktreeId }: { worktreeId: string }) {
  const status = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const owner = useAppStore(() => JSON.stringify([worktreeId, gitGraphScope(worktreeId)?.route]))
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
            aria-label={translate('gitGraph.title', 'Git Graph')}
            onClick={() => void openGitGraph(worktreeId)}
          >
            <GitGraph className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      {support !== null && (
        <TooltipContent>
          {support ? translate('gitGraph.title', 'Git Graph') : gitGraphUpdateMessage(worktreeId)}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
