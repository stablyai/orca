import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { DEFAULT_TERMINAL_THEMES } from '../../../../../../shared/terminal-themes/defaults'
import type { Translate } from '@/i18n/use-translate'
import type { WorkerAutoCloseState } from '../../../../../../shared/orchestration/workers/worker-auto-close'
import { workerAutoCloseBannerProps } from '../../worker-lifetime/worker-auto-close-banner'
import { PaneTopBanner, PaneTopWarningBanner } from './PaneTopWarningBanner'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))

// The temporary-worker strip as the app builds it; the countdown is frozen at 1:42 of 2:00.
const NOW_MS = Date.parse('2026-11-17T12:00:18.000Z')
const RUNNING: WorkerAutoCloseState = { kept: false, closesAt: null }
const FINISHED: WorkerAutoCloseState = { kept: false, closesAt: '2026-11-17T12:02:00.000Z' }
const BOUND_FINISHED: WorkerAutoCloseState = {
  ...FINISHED,
  boundTo: {
    paneKey: 'tab-1:leaf-1',
    worktreeId: null,
    name: 'Refactor the settings migration and verify every platform',
    agent: 'claude'
  }
}

function WorkerPane({
  state,
  terminalTheme,
  floatingControls = false
}: {
  state: WorkerAutoCloseState
  terminalTheme?: keyof typeof DEFAULT_TERMINAL_THEMES
  floatingControls?: boolean
}): React.JSX.Element {
  const props = workerAutoCloseBannerProps(state, NOW_MS, () => {}, t)
  const appTheme = useAppStore((s) => s.settings?.theme)
  // The app sets this from the terminal's background; quiet banners take their colours from it.
  const surface = terminalTheme ? (terminalTheme.includes('Light') ? 'light' : 'dark') : appTheme
  const pane = (
    <div
      className="pane relative h-24 bg-background"
      data-leaf-id="leaf-1"
      data-pane-title-surface={surface}
      style={
        terminalTheme
          ? { backgroundColor: DEFAULT_TERMINAL_THEMES[terminalTheme].background }
          : undefined
      }
    >
      {props ? <PaneTopWarningBanner {...props} /> : null}
    </div>
  )
  if (!floatingControls) {
    return pane
  }
  // Stands in for the chromeless pane header whose four icon controls float over the top-right corner.
  return (
    <div className="relative" data-terminal-overlay-tab-id="tab-1">
      {pane}
      <div className="pane-title-overlay-layer pointer-events-none absolute inset-x-0 top-0">
        <div
          className="pane-title-bar flex h-8 items-center justify-end"
          data-chromeless=""
          data-pane-title-leaf-id="leaf-1"
        >
          <div
            className="pane-title-actions flex items-center gap-1 pr-1 text-muted-foreground"
            style={{ opacity: 1 }}
          >
            {['+', '>', '|', '*'].map((glyph) => (
              <span key={glyph} className="grid size-5 place-items-center rounded border">
                {glyph}
              </span>
            ))}
          </div>
        </div>
      </div>
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

export const workerUnderPaneControls = defineFixture({
  width: 960,
  render: () => (
    <>
      <WorkerPane state={RUNNING} floatingControls />
      <WorkerPane state={FINISHED} floatingControls />
    </>
  )
})

export const workerBoundNarrow = defineFixture({
  width: 360,
  render: () => (
    <>
      <WorkerPane state={BOUND_FINISHED} floatingControls />
      <WorkerPane state={FINISHED} floatingControls />
    </>
  )
})

function ChatWorkerBanner({ state }: { state: WorkerAutoCloseState }): React.JSX.Element | null {
  const props = workerAutoCloseBannerProps(state, NOW_MS, () => {}, t)
  return props ? (
    <PaneTopBanner {...props} className="shrink-0 px-2 font-(family-name:--font-sans)" />
  ) : null
}

export const chatWorker = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col bg-background">
      <ChatWorkerBanner state={RUNNING} />
      <ChatWorkerBanner state={FINISHED} />
      <ChatWorkerBanner state={BOUND_FINISHED} />
    </div>
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
