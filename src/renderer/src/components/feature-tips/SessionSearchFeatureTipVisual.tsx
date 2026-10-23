import { useEffect, useState, type JSX } from 'react'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { DemoSessionPanel, DemoSessionRow } from './feature-tip-session-panel-demo'
import {
  getSessionSearchDemoRecentRows,
  getSessionSearchDemoScenes
} from './session-search-feature-tip-demo'

type DemoPhase = 'idle' | 'typing' | 'searching' | 'results' | 'focused' | 'erasing'
type DemoState = { scene: number; phase: DemoPhase; chars: number }

// Per-step delay; typing and erasing advance one character per step.
const PHASE_MS: Record<DemoPhase, number> = {
  idle: 1100,
  typing: 65,
  searching: 550,
  results: 1300,
  focused: 2200,
  erasing: 24
}

function nextDemoState(state: DemoState, queryLength: number, sceneCount: number): DemoState {
  switch (state.phase) {
    case 'idle':
      return { ...state, phase: 'typing', chars: 0 }
    case 'typing':
      return state.chars < queryLength
        ? { ...state, chars: state.chars + 1 }
        : { ...state, phase: 'searching' }
    case 'searching':
      return { ...state, phase: 'results' }
    case 'results':
      return { ...state, phase: 'focused' }
    case 'focused':
      return { ...state, phase: 'erasing' }
    case 'erasing':
      return state.chars > 0
        ? { ...state, chars: state.chars - 1 }
        : { scene: (state.scene + 1) % sceneCount, phase: 'idle', chars: 0 }
  }
}

export function SessionSearchFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const scenes = getSessionSearchDemoScenes()
  const recentRows = getSessionSearchDemoRecentRows()
  const [state, setState] = useState<DemoState>({ scene: 0, phase: 'idle', chars: 0 })
  // Why: reduced motion freezes on the first answered search instead of looping.
  const shown: DemoState = reducedMotion
    ? { scene: 0, phase: 'results', chars: scenes[0].query.length }
    : state
  const scene = scenes[shown.scene]
  const queryLength = scene.query.length

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const timeoutId = window.setTimeout(
      () => setState((current) => nextDemoState(current, queryLength, scenes.length)),
      // Why: a beat after the last keystroke before the search starts.
      state.phase === 'typing' && state.chars === queryLength
        ? PHASE_MS.typing * 2
        : PHASE_MS[state.phase]
    )
    return () => window.clearTimeout(timeoutId)
  }, [queryLength, reducedMotion, scenes.length, state])

  const showingHits =
    shown.phase === 'results' || shown.phase === 'focused' || shown.phase === 'erasing'
  const rows = showingHits ? scene.hits : recentRows
  const dimmed =
    shown.phase === 'typing' || shown.phase === 'searching' || shown.phase === 'erasing'

  return (
    <DemoSessionPanel
      query={scene.query.slice(0, shown.chars)}
      searching={shown.chars > 0}
      loading={shown.phase === 'searching'}
    >
      <div
        data-dimmed={dimmed}
        className="min-h-0 flex-1 overflow-hidden transition-opacity duration-200 data-[dimmed=true]:opacity-45"
      >
        {rows.map((row, index) => (
          <DemoSessionRow
            key={row.title}
            row={row}
            isHit={showingHits}
            focused={shown.phase === 'focused' && index === 0}
            index={index}
          />
        ))}
      </div>
    </DemoSessionPanel>
  )
}
