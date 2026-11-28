import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import {
  FindBar,
  Tray,
  done,
  failedOnly,
  goal,
  many,
  mixed,
  running,
  single,
  waiting
} from './worker-dock-stack-fixture'

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
export const singleFolded320 = stack(320, false, false, single)
export const singleOpen320 = stack(320, true, false, single)
export const waitingFolded390 = stack(390, false, false, waiting)
export const doneFolded390 = stack(390, false, false, done)
export const manyFolded1000 = stack(1000, false, false, many)

// Eight workers over a long chat with a docked task list: the chip sits above the tasks, the
// transcript runs on under it to the tasks' top edge. Mid-chat (Jump to latest showing) or at the end.
const eight = many.slice(0, 8)
const scrollMid = async () => {
  const element = document.querySelector<HTMLElement>('[data-fixture-transcript]')
  element?.scrollTo({ top: (element.scrollHeight - element.clientHeight) / 2 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}
function withTasks(width: number, open: boolean, end: boolean) {
  return defineFixture({
    width,
    render: () =>
      workerDockFixturePane(<Tray open={open} rows={eight} />, 'queue', {
        goal,
        queued: 1,
        tasks: true
      }),
    interact: end ? undefined : scrollMid
  })
}
export const eightTasksMid320 = withTasks(320, false, false)
export const eightTasksMid390 = withTasks(390, false, false)
export const eightTasksMid1000 = withTasks(1000, false, false)
export const eightTasksEnd390 = withTasks(390, false, true)
export const eightTasksOpen390 = withTasks(390, true, false)
export const eightTasksOpen1000 = withTasks(1000, true, false)
