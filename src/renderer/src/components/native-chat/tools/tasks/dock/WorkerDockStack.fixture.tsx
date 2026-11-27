import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import { FindBar, Tray, failedOnly, goal, many, mixed, running } from './worker-dock-stack-fixture'

// Dev-only: the worker chip and panel in the chat's whole stack above the message box.
// Scrolled up, so Jump to latest shows above the chip or the open panel.
const scrollAway = async () => {
  document.querySelector<HTMLElement>('[data-fixture-transcript]')?.scrollTo({ top: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function stack(width: number, open: boolean, prompt = false, rows = running) {
  return defineFixture({
    width,
    render: () =>
      workerDockFixturePane(<Tray open={open} rows={rows} />, prompt ? 'both' : 'queue', {
        goal,
        find: <FindBar />,
        queued: 2,
        promptReplacesComposer: true
      }),
    interact: scrollAway
  })
}

export const folded320 = stack(320, false)
export const oneFolded320 = stack(320, false, false, running.slice(0, 1))
export const open320 = stack(320, true)
export const promptFolded320 = stack(320, false, true)
export const promptOpen320 = stack(320, true, true)
export const folded720 = stack(720, false)
export const open720 = stack(720, true)
export const open1000 = stack(1000, true)
export const failedFolded320 = stack(320, false, false, failedOnly)
export const failedOpen320 = stack(320, true, false, failedOnly)
export const mixedFolded320 = stack(320, false, false, mixed)
export const mixedOpen320 = stack(320, true, false, mixed)
export const manyFolded390 = stack(390, false, false, many)
export const manyOpen390 = stack(390, true, false, many)
