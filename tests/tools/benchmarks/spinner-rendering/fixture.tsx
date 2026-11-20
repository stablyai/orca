import React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Loader2 } from 'lucide-react'
import { AgentStateDot } from '../../../../src/renderer/src/components/agent/status/AgentStateDot'
import { AgentWorkingSpinner } from '../../../../src/renderer/src/components/agent/status/AgentWorkingSpinner'
import { LoadingSpinner } from '../../../../src/renderer/src/components/ui/LoadingSpinner'
import { installLoopingAnimationClock } from '../../../../src/renderer/src/lib/window-activity/looping-animation-clock'
import { useNow } from '../../../../src/renderer/src/lib/window-activity/use-now'
import './fixture.css'

export type Scenario = {
  /** Working agents on screen; each shows the indicators Orca draws for one. */
  agents: number
  /** A turn's elapsed-time label: 'ticking' repaints once a second, 'quiet' wakes each second but shows the same text. */
  label?: 'ticking' | 'quiet'
  /** Pixels of content above the agents, to push them out of view. */
  offset?: number
  /** Indicators as they were before the shared clock: free-running CSS animations. */
  legacy?: boolean
}

// Before the clock, the ring ran a 12-steps-per-second animation; loaders and pulses ran forever.
const LEGACY_CSS = `
  .agent-working-spinner { animation: agent-spinner-rotate 1s steps(12, end) infinite running; }
  .animate-spin, .animate-pulse { animation-play-state: running; }
  .shimmer { animation-play-state: running; animation-timing-function: steps(30); }
`

function ElapsedLabel({ quiet }: { quiet: boolean }): React.JSX.Element {
  const [startedAt] = React.useState(() => Date.now())
  const now = useNow(1_000)
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return <span data-elapsed="">{quiet ? 'Started a moment ago' : `Working ${seconds}s`}</span>
}

function WorkingAgent(): React.JSX.Element {
  return (
    <div className="flex h-8 items-center gap-3 px-3" data-agent="">
      {/* Tab, sidebar row, workspace card, chat event row, chat loading icon. */}
      <AgentStateDot state="working" size="md" title={null} />
      <AgentStateDot state="working" size="sm" title={null} />
      <AgentWorkingSpinner className="size-2" />
      <AgentWorkingSpinner className="size-[7px] border-[1.5px]" />
      <LoadingSpinner className="size-4" />
      <Loader2 className="size-4 animate-spin" />
      {/* A running tool's label in the chat. */}
      <span className="animate-pulse text-sm motion-reduce:animate-none">Running tests</span>
      {/* A stale review reference on the workspace card. */}
      <span className="shimmer shimmer-duration-2400 shimmer-held text-sm">#123</span>
    </div>
  )
}

// A window shaped like the app: long lists, promoted layers, blurred sticky headers.
const Backdrop = React.memo(function Backdrop(): React.JSX.Element {
  const pane = (name: string, cards: number): React.JSX.Element => (
    <div className="h-full overflow-auto border-r border-border">
      <div className="sticky top-0 z-10 bg-background/60 p-2 backdrop-blur-md">{name}</div>
      {Array.from({ length: cards }, (_, card) => (
        <div
          key={card}
          className="m-2 rounded-lg bg-card p-2 shadow-md"
          style={card % 5 === 0 ? { willChange: 'transform' } : undefined}
        >
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="border-b border-border px-2 py-1.5 text-sm">
              workspace {card}.{row} — lorem ipsum dolor sit amet consectetur adipiscing elit
            </div>
          ))}
        </div>
      ))}
    </div>
  )
  return (
    <div className="grid h-screen grid-cols-[280px_1fr_320px] bg-background text-foreground">
      {pane('Workspaces', 60)}
      {pane('Conversation', 40)}
      {pane('Changes', 60)}
    </div>
  )
})

function Fixture({ agents, label, offset = 0, legacy = false }: Scenario) {
  return (
    <>
      <Backdrop />
      {legacy ? <style>{LEGACY_CSS}</style> : null}
      <div
        id="stage"
        className="fixed top-12 left-[300px] z-20 h-[700px] w-[1150px] overflow-auto bg-background"
        style={{ overflowAnchor: 'none' }}
      >
        {label ? <ElapsedLabel quiet={label === 'quiet'} /> : null}
        <div style={{ height: offset }} />
        {/* Four across, so every requested agent fits in the scrollport. */}
        <div className="grid grid-cols-4">
          {Array.from({ length: agents }, (_, index) => (
            <WorkingAgent key={index} />
          ))}
        </div>
        <div style={{ height: 1000 }} />
      </div>
    </>
  )
}

const root = createRoot(document.getElementById('root')!)
let disposeClock: (() => void) | null = null
Object.assign(window, {
  spinnerBenchmark: {
    render(scenario: Scenario) {
      disposeClock?.()
      disposeClock = scenario.legacy ? null : installLoopingAnimationClock()
      // Unmount first so each scenario starts from freshly mounted indicators.
      flushSync(() => root.render(null))
      flushSync(() => root.render(<Fixture {...scenario} />))
    },
    /** Every looping indicator animation in the document, as the browser sees it. */
    census() {
      return document
        .getAnimations()
        .filter(
          (animation): animation is CSSAnimation =>
            'animationName' in animation &&
            ['spin', 'agent-spinner-rotate', 'pulse', 'tw-shimmer'].includes(
              String(animation.animationName)
            )
        )
        .map((animation) => ({
          name: animation.animationName,
          playState: animation.playState,
          turn:
            Number(animation.currentTime) /
            Number(animation.effect?.getComputedTiming().duration ?? Number.NaN)
        }))
    }
  }
})
