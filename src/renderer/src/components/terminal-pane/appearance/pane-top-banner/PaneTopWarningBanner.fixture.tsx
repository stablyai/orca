import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { DEFAULT_TERMINAL_THEMES } from '../../../../../../shared/terminal-themes/defaults'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

// Mocks for the temporary-worker strip; copy is the owner's, the countdown is frozen at 1:42.
function WorkerPane({
  title,
  action,
  countingDown,
  terminalTheme
}: {
  title: string
  /** A handed-off workspace's strip: neutral, with this action instead of Keep open. */
  action?: string
  countingDown?: boolean
  terminalTheme?: keyof typeof DEFAULT_TERMINAL_THEMES
}): React.JSX.Element {
  return (
    <div
      className="pane relative h-24 bg-background"
      style={
        terminalTheme
          ? { backgroundColor: DEFAULT_TERMINAL_THEMES[terminalTheme].background }
          : undefined
      }
    >
      <PaneTopWarningBanner
        tone={action ? 'neutral' : countingDown ? 'warning' : 'accent'}
        icon={action ? undefined : Timer}
        title={title}
        primaryAction={
          <Button type="button" variant={action ? 'outline' : 'default'} size="xs">
            {action ?? 'Keep open'}
          </Button>
        }
      />
    </div>
  )
}

const running = 'Orchestration worker · Closes 2 minutes after it finishes'
const finished = 'Orchestration worker finished · Closes in 1:42'

export const workerRunning = defineFixture({
  width: 960,
  render: () => <WorkerPane title={running} />
})
export const workerFinished = defineFixture({
  width: 960,
  render: () => <WorkerPane title={finished} countingDown />
})
export const workerFinishedNarrow = defineFixture({
  width: 360,
  render: () => <WorkerPane title={finished} countingDown />
})

export const workerLightTerminal = defineFixture({
  width: 960,
  render: () => (
    <>
      <WorkerPane title={running} terminalTheme="Builtin Tango Light" />
      <WorkerPane title={finished} countingDown terminalTheme="Builtin Tango Light" />
    </>
  )
})

export const workerDarkTerminal = defineFixture({
  width: 960,
  render: () => (
    <>
      <WorkerPane title={running} terminalTheme="Ghostty Default Style Dark" />
      <WorkerPane title={finished} countingDown terminalTheme="Ghostty Default Style Dark" />
    </>
  )
})
export const handedOffToBot = defineFixture({
  width: 960,
  render: () => (
    <WorkerPane
      title="Handed to Atlas · Stays open · You can still type here"
      action="Remove from Atlas"
    />
  )
})
