import { test as base, expect } from './helpers/orca-app'
import {
  presentSidebarMotionWindow,
  type SidebarMotionPresentation
} from './sidebar-motion-presentation'

export { expect }

export const test = base.extend<{ sidebarAnimationFrames: void }>({
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  sidebarAnimationFrames: [
    async ({ electronApp, orcaPage }, provideFixture, testInfo) => {
      const windowGuard = await electronApp.evaluateHandle(({ app, BrowserWindow }) => {
        let showEvents = 0
        let focusEvents = 0
        const onShow = () => showEvents++
        const onFocus = () => focusEvents++
        const windows = new Set<Electron.BrowserWindow>()
        const watch = (window: Electron.BrowserWindow) => {
          windows.add(window)
          if (window.isVisible()) {
            onShow()
          }
          if (window.isFocused()) {
            onFocus()
          }
          window.on('show', onShow)
          window.on('focus', onFocus)
        }
        const onCreated = (_event: Electron.Event, window: Electron.BrowserWindow) => watch(window)
        app.on('browser-window-created', onCreated)
        BrowserWindow.getAllWindows().forEach(watch)
        return {
          finish() {
            app.off('browser-window-created', onCreated)
            for (const window of windows) {
              window.off('show', onShow)
              window.off('focus', onFocus)
            }
            return {
              showEvents,
              focusEvents,
              hidden: BrowserWindow.getAllWindows().every(
                (window) => !window.isVisible() && !window.isFocused()
              )
            }
          }
        }
      })
      let frames = 0
      let acknowledged = 0
      const ackErrors: string[] = []
      const failures: { stage: string; error: unknown }[] = []
      const attempt = async (stage: string, operation: () => Promise<unknown>) => {
        try {
          await operation()
        } catch (error) {
          failures.push({ stage, error })
        }
      }
      const frameSamples: { phase: string; elapsedMs: number[]; timedOut: boolean }[] = []
      let presentation: SidebarMotionPresentation = { presented: false, windows: 0, visible: 0 }
      const sampleFrames = async (phase: string) => {
        const sample = await orcaPage.evaluate(
          () =>
            new Promise<{
              elapsedMs: number[]
              timedOut: boolean
            }>((resolve) => {
              const elapsedMs: number[] = []
              const started = performance.now()
              let frame = 0
              const timeout = setTimeout(() => {
                cancelAnimationFrame(frame)
                resolve({ elapsedMs, timedOut: true })
              }, 5000)
              const tick = () => {
                elapsedMs.push(performance.now() - started)
                if (elapsedMs.length === 3) {
                  clearTimeout(timeout)
                  resolve({ elapsedMs, timedOut: false })
                } else {
                  frame = requestAnimationFrame(tick)
                }
              }
              frame = requestAnimationFrame(tick)
            })
        )
        frameSamples.push({ phase, ...sample })
        expect(sample.timedOut, 'native animation frame sampling timed out').toBe(false)
        // Allow loaded CI frames, but reject Chromium's roughly one-second hidden-frame cadence.
        const gaps = sample.elapsedMs.map(
          (time, index) => time - (sample.elapsedMs[index - 1] ?? 0)
        )
        expect(Math.max(...gaps), 'native animation frame gap').toBeLessThan(500)
      }
      await attempt('capture', async () => {
        await electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
        })
        const cdp = await orcaPage.context().newCDPSession(orcaPage)
        const pending = new Set<Promise<void>>()
        const onFrame = ({ sessionId }: { sessionId: number }) => {
          frames++
          const ack = cdp.send('Page.screencastFrameAck', { sessionId }).then(
            () => {
              acknowledged++
            },
            (error: unknown) => {
              if (ackErrors.length < 3) {
                ackErrors.push(String(error))
              }
            }
          )
          pending.add(ack)
          void ack.finally(() => pending.delete(ack))
        }
        try {
          await orcaPage.setViewportSize({ width: 1280, height: 1024 })
          // Present before sampling: on the hosted Linux lane an unpresented window starves
          // requestAnimationFrame once the page goes idle, which the screencast alone does not fix.
          presentation = await presentSidebarMotionWindow(electronApp, testInfo)
          cdp.on('Page.screencastFrame', onFrame)
          await cdp.send('Page.enable')
          // Consume compositor output to test Chromium's hidden undrawn-frame throttle.
          await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 10,
            maxWidth: 160,
            maxHeight: 128,
            everyNthFrame: 1
          })
          await sampleFrames('before')
          await provideFixture()
          await sampleFrames('after')
        } catch (error) {
          failures.push({ stage: 'sampling or test', error })
        } finally {
          await attempt('stop capture', () => cdp.send('Page.stopScreencast'))
          cdp.off('Page.screencastFrame', onFrame)
          await attempt('drain acknowledgements', () => Promise.all(pending))
          await attempt('detach capture', () => cdp.detach())
        }
      })
      let visibility: { showEvents: number; focusEvents: number; hidden: boolean } | null = null
      await attempt('window visibility', async () => {
        visibility = await windowGuard.evaluate((guard) => guard.finish())
      })
      await attempt('dispose window guard', () => windowGuard.dispose())
      await attempt('capture assertions', async () => {
        if (presentation.presented) {
          expect(presentation.windows).toBeGreaterThan(0)
          expect(presentation.visible).toBe(presentation.windows)
          // One show per presented window, still no focus, and no longer hidden.
          expect(visibility).toEqual({
            showEvents: presentation.windows,
            focusEvents: 0,
            hidden: false
          })
        } else {
          expect(visibility).toEqual({ showEvents: 0, focusEvents: 0, hidden: true })
        }
        expect(ackErrors).toEqual([])
        expect(frames, 'hidden compositor capture produced no frames').toBeGreaterThan(0)
        expect(acknowledged).toBe(frames)
      })
      const evidence = {
        platform: process.platform,
        presentation,
        frames,
        acknowledged,
        ackErrors,
        frameSamples,
        visibility,
        errors: failures.map(({ stage, error }) => ({ stage, error: String(error) })),
        testErrors: testInfo.errors.map((error) => error.message)
      }
      console.log('[sidebar-hidden-capture]', JSON.stringify(evidence))
      await attempt('attach evidence', () =>
        testInfo.attach('sidebar-hidden-capture.json', {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json'
        })
      )
      if (failures.length === 1) {
        throw failures[0].error
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures.map(({ error }) => error),
          'Sidebar capture failed'
        )
      }
    },
    { auto: true }
  ]
})
