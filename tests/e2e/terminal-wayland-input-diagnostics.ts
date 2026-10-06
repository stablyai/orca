import { writeFileSync } from 'node:fs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import type { Event as ElectronEvent, Input as ElectronInput } from 'electron'

const MAX_EVENTS = 2_048
const MAX_STDERR_BYTES = 4 * 1024 * 1024

export async function installTerminalWaylandInputDiagnostics(
  electronApp: ElectronApplication,
  page: Page
) {
  const stderr: Buffer[] = []
  let stderrBytes = 0
  let stderrTruncated = false
  const processStderr = electronApp.process().stderr
  const recordStderr = (chunk: Buffer): void => {
    if (stderrBytes + chunk.length > MAX_STDERR_BYTES) {
      stderrTruncated = true
      return
    }
    stderr.push(Buffer.from(chunk))
    stderrBytes += chunk.length
  }
  processStderr?.on('data', recordStderr)

  const main = await electronApp.evaluateHandle(({ BrowserWindow }, maxEvents) => {
    const events: Record<string, unknown>[] = []
    let dropped = 0
    const removals: (() => void)[] = []
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      const record = (phase: string, input?: ElectronInput, event?: ElectronEvent): void => {
        if (events.length >= maxEvents) {
          dropped++
          return
        }
        const entry = {
          phase,
          wallMs: Date.now(),
          monotonicNs: process.hrtime.bigint().toString(),
          windowId: window.id,
          contentsId: contents.id,
          windowFocused: !window.isDestroyed() && window.isFocused(),
          windowVisible: !window.isDestroyed() && window.isVisible(),
          contentsFocused: !contents.isDestroyed() && contents.isFocused(),
          input: input ? { ...input } : null,
          defaultPreventedBefore: event?.defaultPrevented ?? null,
          defaultPreventedAfter: event?.defaultPrevented ?? null
        }
        events.push(entry)
        if (event) {
          queueMicrotask(() => {
            entry.defaultPreventedAfter = event.defaultPrevented
          })
        }
      }
      const beforeInput = (event: ElectronEvent, input: ElectronInput): void =>
        record('before-input-event', input, event)
      const focused = (): void => record('window-focus')
      const blurred = (): void => record('window-blur')
      contents.prependListener('before-input-event', beforeInput)
      window.on('focus', focused)
      window.on('blur', blurred)
      removals.push(() => {
        contents.removeListener('before-input-event', beforeInput)
        window.removeListener('focus', focused)
        window.removeListener('blur', blurred)
      })
      record('installed')
    }
    return {
      read: () => ({ events, dropped }),
      dispose: () => removals.forEach((remove) => remove())
    }
  }, MAX_EVENTS)

  const renderer = await page.evaluateHandle((maxEvents) => {
    const events: Record<string, unknown>[] = []
    let dropped = 0
    const removals: (() => void)[] = []
    const describe = (target: EventTarget | null): string | null =>
      target instanceof Element ? `${target.tagName}#${target.id}.${target.className}` : null
    const record = (phase: string, event?: Event, data?: string): void => {
      if (events.length >= maxEvents) {
        dropped++
        return
      }
      const keyboard = event instanceof KeyboardEvent ? event : null
      const input = event instanceof InputEvent ? event : null
      const composition = event instanceof CompositionEvent ? event : null
      const entry = {
        phase,
        wallMs: Date.now(),
        monotonicMs: performance.now(),
        timeOriginMs: performance.timeOrigin,
        eventTimeStamp: event?.timeStamp ?? null,
        type: event?.type ?? null,
        target: describe(event?.target ?? null),
        path: event?.composedPath().slice(0, 5).map(describe) ?? [],
        key: keyboard?.key ?? null,
        code: keyboard?.code ?? null,
        keyCode: keyboard?.keyCode ?? null,
        data: data ?? input?.data ?? composition?.data ?? null,
        inputType: input?.inputType ?? null,
        isComposing: keyboard?.isComposing ?? input?.isComposing ?? null,
        trusted: event?.isTrusted ?? null,
        defaultPreventedBefore: event?.defaultPrevented ?? null,
        defaultPreventedAfter: event?.defaultPrevented ?? null,
        documentFocused: document.hasFocus(),
        activeElement: describe(document.activeElement),
        visibility: document.visibilityState,
        value: event?.target instanceof HTMLTextAreaElement ? event.target.value : null
      }
      events.push(entry)
      if (event) {
        queueMicrotask(() => {
          entry.defaultPreventedAfter = event.defaultPrevented
        })
      }
    }
    const types = [
      'keydown',
      'keypress',
      'keyup',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
      'focus',
      'blur'
    ]
    const listen = (target: EventTarget, phase: string): void => {
      const handler = (event: Event): void => record(phase, event)
      for (const type of types) {
        target.addEventListener(type, handler, { capture: true, passive: true })
      }
      removals.push(() => {
        for (const type of types) {
          target.removeEventListener(type, handler, true)
        }
      })
    }
    listen(window, 'window-capture')
    listen(document, 'document-capture')
    record('installed')
    return {
      attachTerminal: () => {
        const state = window.__store?.getState()
        const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
        const textarea = pane?.container.querySelector('.xterm-helper-textarea')
        if (!pane || !textarea) {
          throw new Error('Missing terminal for passive Wayland diagnostics')
        }
        listen(textarea, 'textarea-capture')
        const subscription = pane.terminal.onData((data) =>
          record('terminal-onData', undefined, data)
        )
        removals.push(() => subscription.dispose())
        record('terminal-attached')
      },
      read: () => ({ events, dropped }),
      dispose: () => removals.forEach((remove) => remove())
    }
  }, MAX_EVENTS)

  return {
    attachTerminal: async () => renderer.evaluate((state) => state.attachTerminal()),
    write: async (testInfo: TestInfo): Promise<void> => {
      const protocolPath = testInfo.outputPath('wayland-client-stderr.log')
      writeFileSync(protocolPath, Buffer.concat(stderr))
      const payload = {
        main: await main.evaluate((state) => state.read()),
        renderer: await renderer.evaluate((state) => state.read()),
        stderrBytes,
        stderrTruncated,
        protocolPath,
        listenerOrder:
          'Native observer prepends before-input. DOM captures install after app startup, before test key injection; earlier app window listeners may run first.',
        policy:
          'Observation only: no input cancellation, key replay, focus, reveal, waits or input-method changes.'
      }
      const outputPath = testInfo.outputPath('wayland-input-diagnostics.json')
      writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
      await testInfo.attach('wayland-input-diagnostics.json', {
        path: outputPath,
        contentType: 'application/json'
      })
      await testInfo.attach('wayland-client-stderr.log', {
        path: protocolPath,
        contentType: 'text/plain'
      })
    },
    dispose: async (): Promise<void> => {
      processStderr?.removeListener('data', recordStderr)
      await main.evaluate((state) => state.dispose())
      await renderer.evaluate((state) => state.dispose())
      await main.dispose()
      await renderer.dispose()
    }
  }
}
