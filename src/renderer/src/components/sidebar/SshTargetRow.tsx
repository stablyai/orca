/**
 * Row used in the "Open project on SSH host" step to pick an SSH target.
 *
 * Why extracted: keeps AddRepoSteps.tsx under the 400-line oxlint limit
 * while isolating the inline-connect interaction logic.
 */
import React from 'react'
import { Loader2 } from 'lucide-react'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import {
  beginSshConnect,
  endSshConnect,
  isSshConnectInFlight,
  useSshConnectInFlight
} from '@/ssh/ssh-connect-in-flight'

type Props = {
  target: SshTarget & { state?: SshConnectionState }
  isSelected: boolean
  onSelect: (id: string) => void
  onConnect: (id: string) => Promise<void>
}

export function SshTargetRow({
  target,
  isSelected,
  onSelect,
  onConnect
}: Props): React.JSX.Element {
  // Why: the shared registry replaces local state — every SSH surface dials one connection
  // per target, and it survives this row unmounting mid-connect.
  const connecting = useSshConnectInFlight(target.id)
  const status = target.state?.status ?? 'disconnected'
  const isConnected = status === 'connected'
  const isBusy = connecting || isConnectingSshStatus(status)
  const dotColor = isConnected
    ? 'bg-green-500'
    : isBusy
      ? 'bg-yellow-500'
      : 'bg-muted-foreground/30'

  const handleRowClick = (): void => {
    if (isConnected) {
      onSelect(target.id)
    }
  }

  const handleConnectClick = (e: React.MouseEvent): void => {
    // Why: prevent the row's onClick from also firing and treating the click
    // as a selection when the target is disconnected.
    e.stopPropagation()
    if (isBusy || isSshConnectInFlight(target.id)) {
      return
    }
    beginSshConnect(target.id)
    void onConnect(target.id).finally(() => {
      endSshConnect(target.id)
    })
  }

  return (
    <div
      role={isConnected ? 'button' : undefined}
      tabIndex={isConnected ? 0 : undefined}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-md border text-xs transition-colors ${
        isSelected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50'
      } ${isConnected ? 'cursor-pointer' : ''}`}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (isConnected && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onSelect(target.id)
        }
      }}
    >
      <span className={`size-2 rounded-full shrink-0 ${dotColor}`} />
      <span className={`font-medium truncate ${!isConnected ? 'text-muted-foreground' : ''}`}>
        {target.label || `${target.username}@${target.host}`}
      </span>
      {!isConnected && (
        // Why: inline Connect avoids forcing the user out to Settings just to
        // bring up a configured target.
        <button
          type="button"
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent/70 disabled:opacity-50 disabled:cursor-default flex items-center gap-1"
          onClick={handleConnectClick}
          disabled={isBusy}
        >
          {isBusy ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              {translate('auto.components.sidebar.SshTargetRow.4677394048', 'Connecting…')}
            </>
          ) : (
            translate('auto.components.sidebar.SshTargetRow.75ad429b5d', 'Connect')
          )}
        </button>
      )}
    </div>
  )
}
