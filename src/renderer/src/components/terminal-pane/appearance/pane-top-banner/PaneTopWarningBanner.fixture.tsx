import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { DEFAULT_TERMINAL_THEMES } from '../../../../../../shared/terminal-themes/defaults'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

// Mocks for the temporary-worker strip; copy is the owner's, the countdown is frozen at 1:42.
function WorkerPane({
  title,
  countingDown,
  terminalTheme
}: {
  title: string
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
        tone={countingDown ? 'warning' : 'accent'}
        icon={Timer}
        badge="Temporary"
        title={title}
        primaryAction={
          <Button type="button" variant="default" size="xs">
            Keep open
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
