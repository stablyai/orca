import { app, BrowserWindow, contentTracing } from 'electron'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../../src/main/window/activation/foreground-activation-policy'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Spinner measurements require ORCA_BACKGROUND_LAUNCH=1')
}
app.setPath('userData', path.join(__dirname, 'profile'))
applyBackgroundActivationPolicy()
// Exercise the frame pipeline while keeping the native window hidden.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const FRAME_EVENTS = {
  // Each one redraws the whole window in the GPU process: the cost a spinner must not add.
  displayDraws: 'Display::DrawAndSwap',
  compositorTicks: 'Scheduler::BeginImplFrame',
  mainFrames: 'ProxyMain::BeginMainFrame'
} as const

export type FrameCounts = Record<keyof typeof FRAME_EVENTS, number>

async function countFrames(durationMs: number): Promise<FrameCounts> {
  await contentTracing.startRecording({
    included_categories: ['cc', 'viz', 'benchmark', 'disabled-by-default-cc.debug.scheduler']
  })
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  const file = await contentTracing.stopRecording()
  const events: { name: string; ph: string }[] = JSON.parse(readFileSync(file, 'utf8')).traceEvents
  rmSync(file, { force: true })
  const counts: Record<string, number> = {}
  for (const event of events) {
    if (event.ph !== 'E' && event.ph !== 'e') {
      counts[event.name] = (counts[event.name] ?? 0) + 1
    }
  }
  return {
    displayDraws: counts[FRAME_EVENTS.displayDraws] ?? 0,
    compositorTicks: counts[FRAME_EVENTS.compositorTicks] ?? 0,
    mainFrames: counts[FRAME_EVENTS.mainFrames] ?? 0
  }
}

Object.assign(globalThis, { spinnerBenchmarkCountFrames: countFrames })

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1500,
    height: 950,
    webPreferences: { backgroundThrottling: false }
  })
  await window.loadURL('about:blank')
})
