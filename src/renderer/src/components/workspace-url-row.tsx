import React, { useCallback } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorktreeRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import {
  getPortOpenBrowserTooltipLabel,
  openUrlInWorkspaceBrowser,
  resolvePortOpenInOrcaBrowser
} from '@/lib/workspace-port-actions'
import { translate } from '@/i18n/i18n'

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** The workspace's saved link (`orca worktree set --url`), shown above its live ports. */
export function WorkspaceUrlRow({
  worktreeId,
  url
}: {
  worktreeId: string
  url: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const runtimeTarget = useWorktreeRuntimeTarget(worktreeId)
  const label = displayUrl(url)
  const openLabel = translate(
    'auto.components.sidebar.WorktreeCardPorts.33bc7d7495',
    'Open in Browser'
  )
  const copyLabel = translate(
    'auto.components.sidebar.WorktreeCardPorts.c8067a829a',
    'Copy {{value0}}',
    { value0: url }
  )

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      void openUrlInWorkspaceBrowser({
        url,
        worktreeId,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle,
        openInOrcaBrowser: resolvePortOpenInOrcaBrowser({
          settings,
          // Why: keyboard activations have detail=0; only pointer clicks carry modifier intent.
          event: event.detail > 0 ? event : null,
          isMac: navigator.userAgent.includes('Mac')
        })
      }).then((result) => {
        if (!result.ok) {
          toast.error(
            translate(
              'auto.components.sidebar.WorktreeCardPorts.d1113f4660',
              'Failed to open browser'
            ),
            { description: result.reason }
          )
        }
      })
    },
    [
      createBrowserTab,
      recordFeatureInteraction,
      runtimeTarget,
      setRemoteBrowserPageHandle,
      settings,
      url,
      worktreeId
    ]
  )

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      void window.api.ui.writeClipboardText(url)
      toast.success(
        translate('auto.components.sidebar.WorktreeCardPorts.c89f290e25', 'Copied {{value0}}', {
          value0: url
        })
      )
    },
    [recordFeatureInteraction, url]
  )

  return (
    <div className="group/port grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/50">
      <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
      <div className="relative flex h-5 min-w-0 items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 select-text truncate pr-10 text-[11px] text-muted-foreground">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {url}
          </TooltipContent>
        </Tooltip>
        <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-md border border-border/40 bg-popover/95 px-0.5 can-hover:opacity-0 shadow-xs transition-opacity group-hover/port:opacity-100 group-focus-within/port:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label={openLabel}
            title={getPortOpenBrowserTooltipLabel(openLabel)}
            onClick={handleOpen}
          >
            <ExternalLink className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={handleCopy}
          >
            <Copy className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
