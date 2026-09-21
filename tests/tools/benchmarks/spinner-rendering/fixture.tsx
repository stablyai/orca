import React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { AgentStateDot } from '../../../../src/renderer/src/components/AgentStateDot'
import { UI_ZOOM_MIN, UI_ZOOM_MAX } from '../../../../src/shared/ui-zoom-level'
import './fixture.css'

type FixtureOptions = { count: number; baseline?: boolean; offset?: number; paired?: boolean }

function anchorBaseline(event: React.AnimationEvent<HTMLSpanElement>): void {
  const animation = event.currentTarget.getAnimations()[0]
  if (animation) {
    animation.startTime = 0
  }
}

function Fixture({ count, baseline = false, offset = 0, paired = false }: FixtureOptions) {
  return (
    <div id="scroller" style={{ height: 700, overflow: 'auto', overflowAnchor: 'none' }}>
      <div style={{ height: offset }} />
      <div id="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(20, 32px)' }}>
        {Array.from({ length: count }, (_, index) => {
          const size = index % 4 < 2 ? 'size-2' : 'size-1.5'
          return (
            <div
              className="spinner-cell"
              key={index}
              style={{
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {baseline || (paired && index % 2 === 0) ? (
                <span
                  className={`inline-flex shrink-0 items-center justify-center ${size === 'size-2' ? 'h-3 w-3' : 'h-2.5 w-2.5'}`}
                >
                  <span
                    data-baseline=""
                    onAnimationStart={anchorBaseline}
                    className={`spinner-benchmark-baseline block rounded-full border-2 border-yellow-500 border-t-transparent ${size}`}
                  />
                </span>
              ) : (
                <AgentStateDot
                  state="working"
                  size={size === 'size-2' ? 'md' : 'sm'}
                  title={null}
                />
              )}
            </div>
          )
        })}
      </div>
      <div style={{ height: 1000 }} />
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
let generation = 0
Object.assign(window, {
  spinnerBenchmark: {
    zoomExtremes: [1.2 ** UI_ZOOM_MIN, 1.2 ** UI_ZOOM_MAX],
    render(options: FixtureOptions) {
      flushSync(() => root.render(<Fixture key={++generation} {...options} />))
    }
  }
})
