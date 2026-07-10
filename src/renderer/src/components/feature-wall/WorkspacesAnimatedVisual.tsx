import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { ClaudeIcon, OpenCodeGoIcon } from '../status-bar/icons'

type AgentKind = 'claude' | 'codex' | 'opencode'

type WorkspaceMock = {
  id: string
  name: string
  agents: readonly AgentKind[]
}

const WORKSPACES: readonly WorkspaceMock[] = [
  { id: 'a', name: 'set up orca.yaml', agents: ['claude'] },
  { id: 'b', name: 'fix login race condition', agents: ['claude', 'opencode', 'codex'] },
  { id: 'c', name: 'speed up CI pipeline', agents: ['claude', 'codex'] }
]

const SELECTED_ID = WORKSPACES[0].id
const STEP_MS = 3600
const CARD_GAP_PX = 4
const CARD_HEIGHT_PX_BY_ID: Record<string, number> = {
  a: 66,
  b: 120,
  c: 92
}
const VISUAL_HEIGHT_PX =
  WORKSPACES.reduce((height, ws) => height + CARD_HEIGHT_PX_BY_ID[ws.id], 0) +
  CARD_GAP_PX * (WORKSPACES.length - 1)

function CodexInlineIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="#111"
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
      />
    </svg>
  )
}

function AgentIcon({ kind }: { kind: AgentKind }): JSX.Element {
  if (kind === 'claude') {
    return <ClaudeIcon size={14} />
  }
  if (kind === 'codex') {
    return <CodexInlineIcon />
  }
  return <OpenCodeGoIcon size={14} />
}

function StatusIcon({ running }: { running: boolean }): JSX.Element {
  // Why: reuse the same AgentStateDot primitive that renders on actual
  // workspace cards via DashboardAgentRow, so the tour visual is visually
  // identical to the real UI rather than a one-off lookalike.
  return <AgentStateDot state={running ? 'working' : 'done'} size="md" />
}

export function WorkspacesAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props

  const [{ order, promotedWorkspaceId }, setVisualState] = useState<{
    order: readonly WorkspaceMock[]
    promotedWorkspaceId: string | null
  }>(() => ({ order: WORKSPACES.slice(), promotedWorkspaceId: null }))

  const slotTopById = useMemo(() => {
    const map = new Map<string, number>()
    let top = 0
    order.forEach((ws) => {
      map.set(ws.id, top)
      top += CARD_HEIGHT_PX_BY_ID[ws.id] + CARD_GAP_PX
    })
    return map
  }, [order])

  // The selected workspace should read as the same completed item in every slot;
  // the surrounding workspaces carry the running state while they cycle around it.
  const running = useMemo(() => {
    const map = new Map<string, number>()
    WORKSPACES.forEach((ws) => map.set(ws.id, ws.id === SELECTED_ID ? -1 : 0))
    return map
  }, [])

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const id = window.setInterval(() => {
      setVisualState((current) => {
        const next = current.order.slice()
        const finishing = next.pop()
        if (!finishing) {
          return current
        }
        next.unshift(finishing)
        return { order: next, promotedWorkspaceId: finishing.id }
      })
    }, STEP_MS)
    return () => window.clearInterval(id)
  }, [reducedMotion])
  // Why: reduced-motion mode should display the static stack without a
  // post-render repair; only the animated interval needs promoted z-order.
  const renderedPromotedWorkspaceId = reducedMotion ? null : promotedWorkspaceId

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card p-2.5 text-foreground">
      <div className="relative" style={{ height: VISUAL_HEIGHT_PX }}>
        {WORKSPACES.map((ws) => {
          const isSelected = ws.id === SELECTED_ID
          const runningAgentIndex = running.get(ws.id) ?? -1
          const slotTop = slotTopById.get(ws.id) ?? 0
          const isPromoted = ws.id === renderedPromotedWorkspaceId
          return (
            <div
              key={ws.id}
              data-ws-id={ws.id}
              className={`absolute inset-x-0 rounded-[10px] px-2 py-2.5 transition-[background,box-shadow,transform] duration-[1100ms] [transition-timing-function:cubic-bezier(.2,.8,.2,1)] ${
                isSelected ? 'bg-accent shadow-[inset_0_0_0_1px_rgba(24,24,27,0.06)]' : 'bg-card'
              }`}
              // Why: the card that was bottom before rotation must pass above the
              // cards it crosses; stable slots avoid the old end-of-cycle FLIP snap.
              style={{
                height: CARD_HEIGHT_PX_BY_ID[ws.id],
                transform: `translateY(${slotTop}px)`,
                zIndex: isPromoted ? 30 : 10
              }}
            >
              <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3 px-1.5">
                <span className="inline-block size-[9px] rounded-full bg-emerald-500" />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold leading-[1.2] text-foreground">
                    {ws.name}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2.5 pl-[30px] pr-2 pt-2.5 pb-0.5">
                {ws.agents.map((kind, i) => {
                  const isRunning = i === runningAgentIndex
                  return (
                    <div
                      key={`${ws.id}-${i}`}
                      className="grid grid-cols-[16px_16px_minmax(0,1fr)] items-center gap-2.5"
                    >
                      <span className="inline-flex size-4 items-center justify-center">
                        <StatusIcon running={isRunning} />
                      </span>
                      <AgentIcon kind={kind} />
                      <span
                        className="block h-[9px] rounded-[5px] bg-foreground/[0.16]"
                        style={{ width: `${60 + ((i * 7) % 20)}%` }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
