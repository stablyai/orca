import type { Page } from '@stablyai/playwright-test'

type SyntheticOpenCodeInjectionWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
  __syntheticOpenCodeLoadState?: SyntheticOpenCodeLoadState
}

type SyntheticOpenCodeLoadState = {
  errorMessage?: string
  intervalTimer?: number
  pendingTimers: number[]
  stopped: boolean
}

const SYNTHETIC_PANES_PER_TIMER_TASK = 4

export async function startSyntheticOpenCodeInjection({
  frameCount,
  intervalMs,
  page,
  paneKeys
}: {
  frameCount: number
  intervalMs: number
  page: Page
  paneKeys: string[]
}): Promise<{ stop: () => Promise<void> }> {
  await page.evaluate(
    ({ frameCount, intervalMs, paneKeys, panesPerTimerTask }) => {
      const target = window as SyntheticOpenCodeInjectionWindow
      const injector = target.__terminalPtyDataInjection
      if (!injector) {
        throw new Error('terminal PTY data injection API is unavailable')
      }
      let frameIndex = 0
      const previousState = target.__syntheticOpenCodeLoadState
      if (previousState?.intervalTimer != null) {
        window.clearInterval(previousState.intervalTimer)
      }
      for (const timer of previousState?.pendingTimers ?? []) {
        window.clearTimeout(timer)
      }
      const state: SyntheticOpenCodeLoadState = {
        pendingTimers: [],
        stopped: false
      }
      target.__syntheticOpenCodeLoadState = state
      state.intervalTimer = window.setInterval(() => {
        const frame = frameIndex
        frameIndex += 1
        for (let paneOffset = 0; paneOffset < paneKeys.length; paneOffset += panesPerTimerTask) {
          const paneBatch = paneKeys.slice(paneOffset, paneOffset + panesPerTimerTask)
          // Why: real PTY chunks arrive over several renderer tasks, but not
          // necessarily one browser timer per pane. Small batches keep the
          // harness from creating either one giant callback or timer storms.
          const timer = window.setTimeout(() => {
            state.pendingTimers = state.pendingTimers.filter((id) => id !== timer)
            if (state.stopped || state.errorMessage) {
              return
            }
            for (const [batchIndex, paneKey] of paneBatch.entries()) {
              const paneIndex = paneOffset + batchIndex
              try {
                const injected = injector.inject(
                  paneKey,
                  syntheticOpenCodeFrameSource(paneIndex, frame)
                )
                if (!injected) {
                  state.errorMessage = `no PTY data injector registered for pane key ${paneKey}`
                  return
                }
              } catch (error) {
                state.errorMessage = error instanceof Error ? error.message : String(error)
                return
              }
            }
          }, 0)
          state.pendingTimers.push(timer)
        }
        if (frameIndex >= frameCount && state.intervalTimer != null) {
          window.clearInterval(state.intervalTimer)
          delete state.intervalTimer
        }
      }, intervalMs)

      function syntheticOpenCodeFrameSource(paneIndex: number, frame: number): string {
        const row = (frame % 18) + 4
        const spinner = ['|', '/', '-', '\\'][frame % 4]
        const body = `${'opencode '.repeat(10)}pane=${paneIndex} frame=${frame}`
        return [
          '\x1b[?2026h',
          '\x1b[?25l',
          `\x1b[1;2H\x1b[38;2;255;138;0m${spinner} OpenCode synthetic agent ${paneIndex}\x1b[0m`,
          `\x1b[${row};4H\x1b[38;2;231;237;247m${body.padEnd(118, '#')}\x1b[0m`,
          `\x1b[23;2H\x1b[38;2;106;169;255mstream ${String(frame).padStart(4, '0')} ${'#'.repeat(96)}\x1b[0m`,
          '\x1b[?25h',
          '\x1b[?2026l'
        ].join('')
      }
    },
    {
      frameCount,
      intervalMs,
      paneKeys,
      panesPerTimerTask: SYNTHETIC_PANES_PER_TIMER_TASK
    }
  )

  return {
    stop: async () => {
      await page.evaluate(() => {
        const target = window as SyntheticOpenCodeInjectionWindow
        const state = target.__syntheticOpenCodeLoadState
        if (!state) {
          return
        }
        state.stopped = true
        if (state.intervalTimer != null) {
          window.clearInterval(state.intervalTimer)
          delete state.intervalTimer
        }
        for (const timer of state.pendingTimers) {
          window.clearTimeout(timer)
        }
        const { errorMessage } = state
        delete target.__syntheticOpenCodeLoadState
        if (errorMessage) {
          throw new Error(errorMessage)
        }
      })
    }
  }
}
