import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import { RealComposer, Tray, failedOnly, goal, running } from './worker-dock-stack-fixture'

// Dev-only: every row above the message box, for the rendered edge check
// (tests/tools/worker-dock-rendered/dock-alignment.mjs).
type Variant = {
  open?: boolean
  failed?: boolean
  goal?: boolean
  queue?: boolean
  prompt?: boolean
}
function scene(width: number, variant: Variant) {
  return defineFixture({
    width,
    render: () =>
      workerDockFixturePane(
        <Tray open={variant.open ?? false} rows={variant.failed ? failedOnly : running} />,
        variant.prompt
          ? variant.queue
            ? 'both'
            : 'question'
          : variant.queue
            ? 'queue'
            : undefined,
        {
          goal: variant.goal ? goal : undefined,
          queued: 2,
          promptReplacesComposer: true,
          composer: <RealComposer />
        }
      )
  })
}

export const full320 = scene(320, { goal: true, queue: true })
export const open320 = scene(320, { goal: true, queue: true, open: true })
export const failed320 = scene(320, { goal: true, queue: true, failed: true })
export const bare320 = scene(320, {})
export const goalOnly320 = scene(320, { goal: true })
export const prompt320 = scene(320, { queue: true, prompt: true })
export const full390 = scene(390, { goal: true, queue: true })
export const open390 = scene(390, { goal: true, queue: true, open: true })
export const failed390 = scene(390, { goal: true, queue: true, failed: true })
export const bare390 = scene(390, {})
export const goalOnly390 = scene(390, { goal: true })
export const prompt390 = scene(390, { queue: true, prompt: true })
export const full720 = scene(720, { goal: true, queue: true })
export const open720 = scene(720, { goal: true, queue: true, open: true })
export const failed720 = scene(720, { goal: true, queue: true, failed: true })
export const bare720 = scene(720, {})
export const goalOnly720 = scene(720, { goal: true })
export const prompt720 = scene(720, { queue: true, prompt: true })
