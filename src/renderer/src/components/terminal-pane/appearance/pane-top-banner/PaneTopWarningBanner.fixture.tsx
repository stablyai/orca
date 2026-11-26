import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { DEFAULT_TERMINAL_THEMES } from '../../../../../../shared/terminal-themes/defaults'
import type { Translate } from '@/i18n/use-translate'
import type { WorkerAutoCloseState } from '../../../../../../shared/orchestration/workers/worker-auto-close'
import { workerAutoCloseBannerProps } from '../../worker-lifetime/worker-auto-close-banner'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))

// The temporary-worker strip as the app builds it; the countdown is frozen at 1:42 of 2:00.
const NOW_MS = Date.parse('2026-11-17T12:00:18.000Z')
const RUNNING: WorkerAutoCloseState = { kept: false, closesAt: null }
const FINISHED: WorkerAutoCloseState = { kept: false, closesAt: '2026-11-17T12:02:00.000Z' }

function WorkerPane({
  state,
  terminalTheme
}: {
  state: WorkerAutoCloseState
  terminalTheme?: keyof typeof DEFAULT_TERMINAL_THEMES
}): React.JSX.Element {
  const props = workerAutoCloseBannerProps(state, NOW_MS, () => {}, t)
  return (
    <div
      className="pane relative h-24 bg-background"
      style={
        terminalTheme
          ? { backgroundColor: DEFAULT_TERMINAL_THEMES[terminalTheme].background }
          : undefined
      }
    >
      {props ? <PaneTopWarningBanner {...props} /> : null}
    </div>
  )
}

export const workerRunning = defineFixture({
  width: 960,
  render: () => <WorkerPane state={RUNNING} />
})
export const workerFinished = defineFixture({
  width: 960,
  render: () => <WorkerPane state={FINISHED} />
})
export const workerNarrow = defineFixture({
  width: 320,
  render: () => (
    <>
      <WorkerPane state={RUNNING} />
      <WorkerPane state={FINISHED} />
    </>
  )
})

export const workerLightTerminal = defineFixture({
  width: 960,
  render: () => (
    <>
      <WorkerPane state={RUNNING} terminalTheme="Builtin Tango Light" />
      <WorkerPane state={FINISHED} terminalTheme="Builtin Tango Light" />
    </>
  )
})

export const workerDarkTerminal = defineFixture({
  width: 960,
  render: () => (
    <>
      <WorkerPane state={RUNNING} terminalTheme="Ghostty Default Style Dark" />
      <WorkerPane state={FINISHED} terminalTheme="Ghostty Default Style Dark" />
    </>
  )
})

function HandedOffPane(): React.JSX.Element {
  return (
    <div className="pane relative h-24 bg-background">
      <PaneTopWarningBanner
        tone="neutral"
        title="Handed to Atlas · Stays open · You can still type here"
        primaryAction={
          <Button type="button" variant="outline" size="xs">
            Remove from Atlas
          </Button>
        }
      />
    </div>
  )
}

export const handedOffToBot = defineFixture({
  width: 960,
  render: () => <HandedOffPane />
})
