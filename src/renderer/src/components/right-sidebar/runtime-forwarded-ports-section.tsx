import React, { useState } from 'react'
import { ChevronRight, Copy, KeyRound, Server, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import {
  closeRuntimePortForward,
  runtimePortForwardUrl
} from '@/lib/runtime-port-forwards/runtime-port-forwards-store'
import type { RuntimePortForward } from '../../../../shared/runtime-port-forwards'

/** Forwards whose host port is not in the scan list: SSH access, or a server that stopped. */
export function RuntimeForwardedPortsSection({
  forwards
}: {
  forwards: RuntimePortForward[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const [collapsed, setCollapsed] = useState(false)
  if (forwards.length === 0) {
    return null
  }
  return (
    <div className="px-3 pt-2" data-runtime-forwarded-ports="">
      <button
        type="button"
        className="sticky top-0 z-10 mb-1 flex w-full items-center gap-1 border-b border-border/40 bg-background py-1 text-left text-muted-foreground hover:text-foreground motion-safe:transition-colors"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-controls="runtime-other-forwards"
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 motion-safe:transition-transform', !collapsed && 'rotate-90')}
        />
        <span className="text-3xs font-semibold uppercase tracking-wider">
          {t('auto.components.right.sidebar.RuntimeForwardedPorts.title', 'Other forwards')}
        </span>
        <span className="ml-1 text-3xs text-muted-foreground/60">{forwards.length}</span>
      </button>
      {collapsed ? null : (
        <div id="runtime-other-forwards">
          {forwards.map((forward) => (
            <OtherForwardRow key={forward.id} forward={forward} />
          ))}
        </div>
      )}
    </div>
  )
}

function OtherForwardRow({ forward }: { forward: RuntimePortForward }): React.JSX.Element {
  const t = useTranslate()
  const ssh = forward.reason === 'ssh'
  const address = `localhost:${forward.localPort}`
  const detail = [
    address,
    forward.openConnections > 0
      ? t(
          'auto.components.right.sidebar.RuntimeForwardedPorts.connections',
          'in use ({{value0}})',
          { value0: forward.openConnections }
        )
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="group -mx-1 flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/50 motion-safe:transition-colors">
      <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/70">
        {ssh ? <KeyRound size={13} aria-hidden /> : <Server size={13} aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">:{forward.remotePort}</span>
          <span className="truncate text-xs text-muted-foreground">
            {ssh
              ? t('auto.components.right.sidebar.RuntimeForwardedPorts.ssh', 'SSH access')
              : (forward.label ?? '')}
          </span>
          {ssh ? null : (
            <span className="shrink-0 rounded-sm border border-border px-1 text-3xs text-muted-foreground">
              {t('auto.components.right.sidebar.RuntimeForwardedPorts.stopped', 'stopped')}
            </span>
          )}
        </div>
        <div className="truncate text-2xs text-muted-foreground">{detail}</div>
      </div>
      <div className="flex items-center gap-0.5 can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 motion-safe:transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                void window.api.ui.writeClipboardText(
                  ssh ? address : runtimePortForwardUrl(forward)
                )
              }
              aria-label={t(
                'auto.components.right.sidebar.PortsPanel.1004af16ab',
                'Copy {{value0}}',
                {
                  value0: address
                }
              )}
            >
              <Copy size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t('auto.components.right.sidebar.PortsPanel.1004af16ab', 'Copy {{value0}}', {
              value0: address
            })}
          </TooltipContent>
        </Tooltip>
        {/* SSH access owns its forward; it closes with the SSH session. */}
        {ssh ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void closeRuntimePortForward(forward)}
                aria-label={t(
                  'auto.components.right.sidebar.RuntimeForwardedPorts.stopLabel',
                  'Stop forwarding port {{value0}}',
                  { value0: forward.remotePort }
                )}
              >
                <Unplug size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t('auto.components.right.sidebar.RuntimePortForward.stop', 'Stop Forwarding')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
