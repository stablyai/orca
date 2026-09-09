import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HostRowIcon } from '../host-row-icon'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

type NoticeHostGlyphProps = {
  hostId: ExecutionHostId
  hostLabel: string
  keyboardFocusable: boolean
}

/**
 * The host indicator for a discovery-notice row.
 *
 * Deliberately the one host glyph vocabulary the composer's run-target rows
 * already use (HostRowIcon: a monitor for this computer, a server for anything
 * remote), plus the worktree card's "Project on …" tooltip. Every row gets one,
 * including local, so no row is the odd one out.
 */
export default function NoticeHostGlyph({
  hostId,
  hostLabel,
  keyboardFocusable
}: NoticeHostGlyphProps): React.JSX.Element | null {
  const host = parseExecutionHostId(hostId)
  const isDisconnected = useAppStore((s) => {
    if (host?.kind !== 'runtime') {
      return false
    }
    return !s.runtimeStatusByEnvironmentId.get(host.environmentId)?.status
  })

  if (!host) {
    return null
  }

  const tooltip = isDisconnected
    ? translate(
        'auto.components.sidebar.NoticeHostGlyph.hostDisconnected',
        '{{hostName}} disconnected',
        { hostName: hostLabel }
      )
    : host.kind === 'ssh'
      ? translate(
          'auto.components.sidebar.NoticeHostGlyph.sshHostProject',
          'Project on SSH host {{hostName}}',
          { hostName: hostLabel }
        )
      : host.kind === 'local'
        ? translate(
            'auto.components.sidebar.NoticeHostGlyph.localHostProject',
            'Project on this host'
          )
        : translate(
            'auto.components.sidebar.NoticeHostGlyph.runtimeHostProject',
            'Project on {{hostName}}',
            { hostName: hostLabel }
          )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={keyboardFocusable ? tooltip : undefined}
          className="inline-flex shrink-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
          data-notice-host-kind={host.kind}
          role={keyboardFocusable ? 'img' : undefined}
          tabIndex={keyboardFocusable ? 0 : undefined}
        >
          <HostRowIcon
            hostId={hostId}
            className={`size-3 shrink-0 ${
              isDisconnected ? 'text-destructive' : 'text-muted-foreground'
            }`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
