import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import { StatusesPage } from './agents-orchestration/StatusesPage'
import { UsagePage } from './agents-orchestration/UsagePage'
import { OrchestrationPage } from './agents-orchestration/OrchestrationPage'

const PANEL_HEIGHT_PX = 392
const PANEL_WIDTH_PX = 520

export function AgentsOrchestrationVisual(props: {
  reducedMotion: boolean
  activeStepId: AgentsStepId
  widthPx?: number
  heightPx?: number
  orchestrationCreatedChildCount?: number
  orchestrationLoopMs?: number
  orchestrationShowResponseBeats?: boolean
}): JSX.Element {
  const {
    reducedMotion,
    activeStepId,
    widthPx,
    heightPx,
    orchestrationCreatedChildCount,
    orchestrationLoopMs,
    orchestrationShowResponseBeats
  } = props
  return (
    <div
      className="relative flex flex-col text-foreground"
      style={{ width: widthPx ?? PANEL_WIDTH_PX, height: heightPx ?? PANEL_HEIGHT_PX }}
    >
      <Page active={activeStepId === 'statuses'}>
        <StatusesPage active={activeStepId === 'statuses'} reducedMotion={reducedMotion} />
      </Page>
      <Page active={activeStepId === 'usage'}>
        <UsagePage active={activeStepId === 'usage'} reducedMotion={reducedMotion} />
      </Page>
      <Page active={activeStepId === 'orchestration'}>
        <OrchestrationPage
          active={activeStepId === 'orchestration'}
          reducedMotion={reducedMotion}
          controlledCreatedChildCount={orchestrationCreatedChildCount}
          loopMs={orchestrationLoopMs}
          showResponseBeats={orchestrationShowResponseBeats}
        />
      </Page>
    </div>
  )
}

function Page(props: { active: boolean; children: JSX.Element }): JSX.Element {
  return (
    <div
      aria-hidden={!props.active}
      className={cn(
        'absolute inset-0 transition-[opacity,transform] duration-[360ms] ease-out',
        props.active
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-1 opacity-0'
      )}
    >
      {props.children}
    </div>
  )
}
