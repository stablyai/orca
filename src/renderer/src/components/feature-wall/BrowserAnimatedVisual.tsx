import type { JSX } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { BrowserAgentVerificationPane } from './BrowserAgentVerificationPane'
import { BrowserStoryboardWindow } from './BrowserStoryboardWindow'
import {
  BROWSER_REDUCED_MOTION_STATE,
  isBrowserSplitPhase,
  type BrowserVisualState,
  type BrowserVisualTargetRefs
} from './browser-animated-visual-phase'
import {
  useBrowserAnimatedVisualStoryboard,
  useBrowserVisualTargetRefs
} from './use-browser-animated-visual-storyboard'

export function BrowserAnimatedVisual(props: {
  reducedMotion: boolean
  onCycleComplete?: () => void
}): JSX.Element {
  const targets = useBrowserVisualTargetRefs()
  const newBrowserShortcutLabel = useShortcutLabel('tab.newBrowser')

  // Why: branch on the state source, not the element type, so a reducedMotion
  // toggle re-renders the storyboard in place instead of remounting it.
  const animatedState = useBrowserAnimatedVisualStoryboard(
    targets,
    props.reducedMotion,
    props.onCycleComplete
  )

  return (
    <BrowserVisualFrame
      state={props.reducedMotion ? BROWSER_REDUCED_MOTION_STATE : animatedState}
      targets={targets}
      newBrowserShortcutLabel={newBrowserShortcutLabel}
    />
  )
}

function BrowserVisualFrame(props: {
  state: BrowserVisualState
  targets: BrowserVisualTargetRefs
  newBrowserShortcutLabel: string
}): JSX.Element {
  const isSplit = isBrowserSplitPhase(props.state.phase)
  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full" style={{ height: 270 }}>
        <div
          className="absolute inset-0 grid transition-[grid-template-columns,gap] duration-500 ease-out"
          style={{
            gridTemplateColumns: isSplit ? '1fr 1fr' : '1fr 0fr',
            gap: isSplit ? 10 : 0
          }}
        >
          <BrowserStoryboardWindow
            state={props.state}
            targets={props.targets}
            newBrowserShortcutLabel={props.newBrowserShortcutLabel}
          />
          <BrowserAgentVerificationPane phase={props.state.phase} splitVisible={isSplit} />
        </div>
      </div>
      <style>
        {translate(
          'auto.components.feature.wall.BrowserAnimatedVisual.1bec24acc1',
          '@keyframes browserFlash { 0% { opacity: 0; } 20% { opacity: 0.85; } 100% { opacity: 0; } } @keyframes browserTabIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } } @keyframes browserViewIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }'
        )}
      </style>
    </div>
  )
}
