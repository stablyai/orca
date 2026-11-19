import { Profiler, useEffect, useState, type ProfilerOnRenderCallback } from 'react'
import { flushSync } from 'react-dom'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AgentKanbanBoard } from '../board/AgentKanbanBoard'
import type { AgentDashboardView } from '../board/AgentDashboardViewToggle'
import { saveAgentDashboardView } from '../board/agent-dashboard-view-storage'
import { saveFleetCollapsedProjects } from './fleet-collapsed-projects-storage'
import { buildFleetScaleSnapshot } from './fleet-scale-snapshot-fixtures'

const ENGLISH = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }
const SCALE_NOW = Date.now()
const NO_FLIPS: ReadonlySet<number> = new Set()
const UPDATE_CADENCE_MS = 250
const FLIP_STRIDE = 37

type FleetPerfCommit = { phase: string; actualDuration: number; commitTime: number }

type FleetPerfTick = {
  tick: number
  flippedIndex: number
  flippedToAttention: boolean
  flushMs: number
  layoutMs: number
  profilerMs: number
  commits: number
  expectedFleetNodes: number
}

type FleetPerf = {
  cardCount: number
  view: AgentDashboardView
  expectedFleetNodes: number
  commits: FleetPerfCommit[]
  ticks: FleetPerfTick[]
  pendingTick: { profilerMs: number; commits: number } | null
}

// Read by the out-of-repo perf harness through window.__fleetPerf.
const perf: FleetPerf = {
  cardCount: 0,
  view: 'board',
  expectedFleetNodes: 0,
  commits: [],
  ticks: [],
  pendingTick: null
}

const recordCommit: ProfilerOnRenderCallback = (
  _id,
  phase,
  actualDuration,
  _baseDuration,
  _startTime,
  commitTime
) => {
  if (perf.pendingTick) {
    perf.pendingTick.profilerMs += actualDuration
    perf.pendingTick.commits += 1
    return
  }
  perf.commits.push({ phase, actualDuration, commitTime })
}

function nextFlips(flipped: ReadonlySet<number>, index: number): ReadonlySet<number> {
  const next = new Set(flipped)
  if (!next.delete(index)) {
    next.add(index)
  }
  return next
}

function ScaleDashboard({
  cardCount,
  updates
}: {
  cardCount: number
  updates: boolean
}): React.JSX.Element {
  const [scale, setScale] = useState(() => buildFleetScaleSnapshot(cardCount, SCALE_NOW, NO_FLIPS))
  useEffect(() => {
    if (!updates) {
      return
    }
    let tick = 0
    let flipped = NO_FLIPS
    const timer = window.setInterval(() => {
      tick += 1
      const flippedIndex = (tick * FLIP_STRIDE) % cardCount
      flipped = nextFlips(flipped, flippedIndex)
      const next = buildFleetScaleSnapshot(cardCount, SCALE_NOW, flipped)
      const pending = { profilerMs: 0, commits: 0 }
      perf.pendingTick = pending
      const start = performance.now()
      flushSync(() => setScale(next))
      const flushed = performance.now()
      document.body.getBoundingClientRect()
      const laidOut = performance.now()
      perf.pendingTick = null
      perf.ticks.push({
        tick,
        flippedIndex,
        flippedToAttention: next.snapshot.cards[flippedIndex].bucket === 'attention',
        flushMs: flushed - start,
        layoutMs: laidOut - flushed,
        ...pending,
        expectedFleetNodes: next.expectedFleetNodes
      })
    }, UPDATE_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [cardCount, updates])
  return (
    <Profiler id="agent-dashboard-scale" onRender={recordCommit}>
      <AgentKanbanBoard snapshot={scale.snapshot} containerClassName="h-[760px] w-full" />
    </Profiler>
  )
}

function scaleFixture(cardCount: number, view: AgentDashboardView, updates: boolean) {
  return defineFixture({
    store: ENGLISH,
    width: 1240,
    setup: () => {
      saveAgentDashboardView(view)
      saveFleetCollapsedProjects(new Set())
      Object.assign(perf, {
        cardCount,
        view,
        expectedFleetNodes: buildFleetScaleSnapshot(cardCount, SCALE_NOW, NO_FLIPS)
          .expectedFleetNodes,
        commits: [],
        ticks: [],
        pendingTick: null
      })
      Object.assign(window, { __fleetPerf: perf })
    },
    render: () => <ScaleDashboard cardCount={cardCount} updates={updates} />
  })
}

export const scale100Fleet = scaleFixture(100, 'fleet', false)
export const scale300Fleet = scaleFixture(300, 'fleet', false)
export const scale100Board = scaleFixture(100, 'board', false)
export const scale300Board = scaleFixture(300, 'board', false)
export const scale300FleetUpdates = scaleFixture(300, 'fleet', true)
export const scale300BoardUpdates = scaleFixture(300, 'board', true)
