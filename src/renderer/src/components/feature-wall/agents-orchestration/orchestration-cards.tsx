import type { JSX } from 'react'
import { CircleCheck } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { cn } from '@/lib/utils'
import type { AgentKey, AgentRowState } from './orchestration-types'

export function WorkspaceCard(props: {
  variant: 'coordinator' | 'default'
  name: string
  dataCard: string
  rows: JSX.Element[]
  childPadding?: boolean
  dimName?: boolean
  amberDot?: boolean
}): JSX.Element {
  const { variant, name, dataCard, rows, childPadding, dimName, amberDot } = props
  return (
    <div
      data-feature-wall-card={dataCard}
      className={cn(
        'relative flex flex-col gap-[7px] rounded-[9px] px-[13px] py-[11px]',
        variant === 'coordinator'
          ? 'bg-foreground/[0.04] shadow-[inset_0_0_0_1px_rgba(24,24,27,0.14)]'
          : 'bg-card shadow-[inset_0_0_0_1px_rgba(24,24,27,0.10),0_1px_2px_rgba(24,24,27,0.03)]'
      )}
    >
      <div className="grid grid-cols-[12px_minmax(0,1fr)] items-center gap-[9px]">
        <span
          className="block size-[9px] rounded-full"
          style={{
            background: amberDot ? 'rgb(245 158 11)' : 'rgb(16 185 129)',
            margin: '0 auto'
          }}
          aria-hidden
        />
        <span
          className={cn(
            'truncate font-semibold leading-[1.2] text-foreground',
            dimName && 'opacity-55'
          )}
          style={{
            fontSize: 'var(--feature-wall-workspace-title-size, 14.5px)',
            ...(dimName ? { opacity: 0.55 } : {})
          }}
        >
          {name}
        </span>
      </div>
      <div className={cn('flex flex-col gap-[6px]', childPadding && 'pl-0.5')}>{rows}</div>
    </div>
  )
}

export function AgentRow(props: {
  agentKey: AgentKey
  icon: JSX.Element
  state: AgentRowState
  message: string
  flashKey: number
  pending?: boolean
  spawnRow?: boolean
  registerRef: (node: HTMLDivElement | null) => void
}): JSX.Element {
  const { icon, state, message, flashKey, pending, spawnRow, registerRef } = props
  return (
    <div
      ref={registerRef}
      className={cn(
        'feature-wall-agent-row grid items-center pl-1',
        spawnRow && 'feature-wall-spawn-row'
      )}
      style={{
        columnGap: 'var(--feature-wall-agent-row-gap, 9px)',
        gridTemplateColumns:
          'var(--feature-wall-agent-status-col, 16px) var(--feature-wall-agent-icon-col, 16px) minmax(0, 1fr)'
      }}
      data-pending={pending ? 'true' : undefined}
    >
      <span
        className="feature-wall-agent-status inline-flex items-center justify-center"
        style={{
          height: 'var(--feature-wall-agent-status-box, 16px)',
          width: 'var(--feature-wall-agent-status-box, 16px)'
        }}
      >
        {state === "working" ? (
          <AgentStateDot state="working" size="md" />
        ) : (
          <span
            className="inline-flex items-center justify-center text-emerald-500"
            style={{
              height: 'var(--feature-wall-agent-status-icon, 12px)',
              width: 'var(--feature-wall-agent-status-icon, 12px)'
            }}
          >
            <CircleCheck
              aria-hidden
              style={{
                height: 'var(--feature-wall-agent-status-icon, 12px)',
                width: 'var(--feature-wall-agent-status-icon, 12px)'
              }}
            />
          </span>
        )}
      </span>
      <span
        className="feature-wall-agent-icon inline-flex items-center justify-center"
        style={{
          height: 'var(--feature-wall-agent-icon-box, 16px)',
          width: 'var(--feature-wall-agent-icon-box, 16px)'
        }}
      >
        {icon}
      </span>
      <span
        // Why: re-keying on flashKey forces React to remount the span so the
        // CSS `feature-wall-msg-received` animation actually replays each
        // time a new message lands. Without the remount, the same DOM node
        // keeps its already-finished animation and only the text changes.
        key={flashKey}
        className={cn(
          'truncate leading-[1.3] text-foreground',
          flashKey > 0 && 'feature-wall-msg-received'
        )}
        style={{ fontSize: 'var(--feature-wall-agent-message-size, 13px)' }}
      >
        {message}
      </span>
    </div>
  )
}
