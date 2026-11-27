import { useCallback, useEffect, useRef, useState } from 'react'
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

export type GitGraphSupport = {
  /** Whether this worktree's host can open Git Graph: null while the first probe runs or when disabled. */
  support: boolean | null
  /** Probes again, e.g. when a control that was hidden while unsupported is shown. */
  recheck: () => void
}

export function useGitGraphSupport(worktreeId: string, enabled = true): GitGraphSupport {
  // Hidden section bodies stop these subscriptions; a primitive key keeps unrelated writes from rendering.
  const owner = useSourceControlState((state) =>
    JSON.stringify([worktreeId, gitGraphScope(worktreeId, state)?.route])
  )
  const status = useAppStateValueWithHostStatuses((state, statuses) => {
    const environmentId = gitGraphScope(worktreeId, state)?.route.runtimeEnvironmentId
    return environmentId ? statuses.get(environmentId) : undefined
  })
  const [probe, setProbe] = useState<{ owner: string; support: boolean | null }>()
  const [recheckCount, setRecheckCount] = useState(0)
  const recheck = useCallback(() => setRecheckCount((count) => count + 1), [])
  useEffect(() => {
    if (!enabled) {
      return
    }
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
  }, [enabled, worktreeId, owner, status, recheckCount])
  return { support: enabled && probe?.owner === owner ? probe.support : null, recheck }
}

export function GitGraphOpenButton({
  worktreeId,
  support: { support, recheck },
  onOpen,
  iconOnly = false
}: {
  worktreeId: string
  /** From `useGitGraphSupport`, owned by the panel so the scope menu shares one probe. */
  support: GitGraphSupport
  onOpen?: (event: SourceControlRowOpenEvent) => void
  /** Icon with a tooltip, for the file-list header's tool cluster. */
  iconOnly?: boolean
}) {
  const t = useTranslate()
  // The toolbar hides this button while the filter is open; when it returns unsupported, the host may have updated since.
  const recheckedOnMount = useRef(false)
  useEffect(() => {
    if (recheckedOnMount.current) {
      return
    }
    recheckedOnMount.current = true
    if (support === false) {
      recheck()
    }
  }, [support, recheck])
  const label = t('auto.components.right.sidebar.SourceControl.gitGraphButton', 'Graph')
  const button = (
    <Button
      type="button"
      variant={iconOnly ? 'ghost-muted' : 'ghost'}
      size={iconOnly ? 'icon-xs' : 'xs'}
      className={iconOnly ? 'size-5' : undefined}
      disabled={support !== true}
      aria-label={iconOnly ? label : undefined}
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
      {iconOnly ? null : label}
    </Button>
  )
  if (support !== false) {
    return iconOnly ? (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    ) : (
      button
    )
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
