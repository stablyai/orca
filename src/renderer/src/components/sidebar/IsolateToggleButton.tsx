import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Box, LoaderCircle, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  DockerBuildProgress,
  DockerEngineStatus,
  Worktree,
  WorktreeIsolation
} from '../../../../shared/types'

type IsolateToggleButtonProps = {
  worktreeId: string
}

export type IsolateToggleView = {
  disabled: boolean
  active: boolean
  building: boolean
  tooltip: string
  label: string
}

export function getIsolateToggleView(input: {
  isolation: WorktreeIsolation
  engineStatus: DockerEngineStatus | null
  progress: DockerBuildProgress | null
  isSshRepo?: boolean
}): IsolateToggleView {
  const active = input.isolation === 'docker'
  // Why: Docker builds run locally, but SSH repo paths point at the remote host.
  if (input.isSshRepo) {
    return {
      disabled: true,
      active: false,
      building: false,
      tooltip: "Docker isolation isn't available for SSH-mounted repos.",
      label: "Docker isolation isn't available for SSH-mounted repos."
    }
  }
  if (input.engineStatus && !input.engineStatus.available) {
    return {
      disabled: true,
      active: false,
      building: false,
      tooltip: input.engineStatus.reason ?? 'Docker not detected',
      label: 'Docker not detected'
    }
  }
  if (input.progress && input.progress.phase !== 'ready' && input.progress.phase !== 'failed') {
    return {
      disabled: true,
      active,
      building: true,
      tooltip: 'Build image and enable Docker isolation',
      label: formatBuildProgress(input.progress)
    }
  }
  return {
    disabled: false,
    active,
    building: false,
    tooltip: active ? 'Docker isolation on' : 'Build image and enable Docker isolation',
    label: active ? 'Docker isolation on' : 'Build image and enable Docker isolation'
  }
}

export function formatBuildProgress(progress: DockerBuildProgress): string {
  const base =
    progress.phase === 'pull'
      ? 'Pulling image...'
      : progress.phase === 'build'
        ? 'Building image...'
        : progress.phase === 'ready'
          ? 'Docker image ready'
          : 'Docker build failed'
  return progress.percent != null ? `${base} ${progress.percent}%` : base
}

export default function IsolateToggleButton({
  worktreeId
}: IsolateToggleButtonProps): React.JSX.Element {
  const worktree = useAppStore((s) => findWorktree(s.worktreesByRepo, worktreeId))
  const repo = useAppStore((s) =>
    worktree ? (s.repos.find((entry) => entry.id === worktree.repoId) ?? null) : null
  )
  const setIsolation = useAppStore((s) => s.setIsolation)
  const [engineStatus, setEngineStatus] = useState<DockerEngineStatus | null>(null)
  const [progress, setProgress] = useState<DockerBuildProgress | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshEngineStatus = useCallback(() => {
    window.api.docker
      .engineStatus()
      .then((status) => {
        if (!mountedRef.current) {
          return
        }
        setEngineStatus(status)
      })
      .catch((error) => {
        if (!mountedRef.current) {
          return
        }
        setEngineStatus({
          available: false,
          flavor: 'docker-engine-linux',
          reason: error instanceof Error ? error.message : String(error)
        })
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.docker
      .engineStatus()
      .then((status) => {
        if (!cancelled) {
          setEngineStatus(status)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEngineStatus({
            available: false,
            flavor: 'docker-engine-linux',
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.api.docker.onBuildProgress((nextProgress) => {
      if (nextProgress.worktreeId === worktreeId) {
        setProgress(nextProgress)
      }
    })
  }, [worktreeId])

  const isolation = worktree?.isolation ?? 'host'
  const view = useMemo(
    () =>
      getIsolateToggleView({
        isolation,
        engineStatus,
        progress,
        isSshRepo: !!repo?.connectionId
      }),
    [isolation, engineStatus, progress, repo?.connectionId]
  )

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!worktree || view.disabled) {
        return
      }
      if (isolation === 'docker') {
        await setIsolation(worktreeId, 'host')
        return
      }
      try {
        setProgress({ worktreeId, phase: 'pull' })
        const result = await window.api.docker.buildImage({ repoId: worktree.repoId, worktreeId })
        if (hasDockerBuildError(result)) {
          throw new Error(result.error)
        }
        await setIsolation(worktreeId, 'docker')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error('Docker image build failed', { description: message })
        await setIsolation(worktreeId, 'host')
      }
    },
    [isolation, setIsolation, view.disabled, worktree, worktreeId]
  )

  const Icon = view.building ? LoaderCircle : view.active ? ShieldCheck : Box

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          onPointerEnter={refreshEngineStatus}
          onFocus={refreshEngineStatus}
          aria-disabled={view.disabled}
          aria-label={view.label}
          aria-pressed={view.active}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
            view.disabled
              ? 'cursor-not-allowed text-muted-foreground/35'
              : 'hover:bg-sidebar-accent',
            view.active ? 'text-foreground' : 'text-muted-foreground/60'
          )}
        >
          <Icon className={cn('size-3.5', view.building && 'animate-spin')} />
          {view.building ? <span className="sr-only">{view.label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{view.building ? view.label : view.tooltip}</span>
      </TooltipContent>
    </Tooltip>
  )
}

function findWorktree(
  worktreesByRepo: Record<string, Worktree[]> | null | undefined,
  worktreeId: string
): Worktree | undefined {
  // Why: the sidebar can render before workspace lists hydrate, and SSR tests
  // often mock only the WorktreeCard inputs rather than the full store slice.
  if (!worktreesByRepo) {
    return undefined
  }
  for (const worktrees of Object.values(worktreesByRepo)) {
    const found = worktrees.find((worktree) => worktree.id === worktreeId)
    if (found) {
      return found
    }
  }
  return undefined
}

function hasDockerBuildError(result: unknown): result is { error: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof (result as { error?: unknown }).error === 'string'
  )
}
