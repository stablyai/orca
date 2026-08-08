import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'

export type TerminalImeDomEvent = {
  type: string
  data: string | null
  inputType: string | null
  key: string | null
  code: string | null
  keyCode: number | null
  isComposing: boolean | null
  selectionEnd: number | null
  selectionStart: number | null
  value: string
  altGraph?: boolean | null
  altKey?: boolean | null
  charCode?: number | null
  composed?: boolean
  ctrlKey?: boolean | null
  defaultPrevented?: boolean
  location?: number | null
  metaKey?: boolean | null
  repeat?: boolean | null
  shiftKey?: boolean | null
  timeStamp?: number
  target?: { className: string; tagName: string } | null
  which?: number | null
}

export type TerminalImeDataEvent = {
  data: string
  timeStamp: number
}

export type TerminalImeBoundaryTrace = {
  dom: TerminalImeDomEvent[]
  onData: string[]
  onDataEvents?: TerminalImeDataEvent[]
}

type TerminalImeProbeWindow = Window & {
  __terminalImeBoundaryProbe?: TerminalImeBoundaryTrace & { dispose: () => void }
}

export async function installTerminalImeBoundaryProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as TerminalImeProbeWindow
    targetWindow.__terminalImeBoundaryProbe?.dispose()

    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error('No active terminal textarea for IME boundary probe')
    }

    const dom: TerminalImeDomEvent[] = []
    const onData: string[] = []
    const onDataEvents: TerminalImeDataEvent[] = []
    const record = (event: Event): void => {
      const input = event instanceof InputEvent ? event : null
      const composition = event instanceof CompositionEvent ? event : null
      const keyboard = event instanceof KeyboardEvent ? event : null
      dom.push({
        type: event.type,
        data: input?.data ?? composition?.data ?? null,
        inputType: input?.inputType ?? null,
        key: keyboard?.key ?? null,
        code: keyboard?.code ?? null,
        keyCode: keyboard?.keyCode ?? null,
        isComposing: keyboard?.isComposing ?? input?.isComposing ?? null,
        selectionEnd: textarea.selectionEnd,
        selectionStart: textarea.selectionStart,
        value: textarea.value,
        altGraph: keyboard?.getModifierState('AltGraph') ?? null,
        altKey: keyboard?.altKey ?? null,
        charCode: keyboard?.charCode ?? null,
        composed: event.composed,
        ctrlKey: keyboard?.ctrlKey ?? null,
        defaultPrevented: event.defaultPrevented,
        location: keyboard?.location ?? null,
        metaKey: keyboard?.metaKey ?? null,
        repeat: keyboard?.repeat ?? null,
        shiftKey: keyboard?.shiftKey ?? null,
        timeStamp: event.timeStamp,
        target:
          event.target instanceof Element
            ? { className: event.target.className, tagName: event.target.tagName }
            : null,
        which: keyboard?.which ?? null
      })
    }
    const eventTypes = [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
      'keydown',
      'keypress',
      'keyup'
    ]
    for (const eventType of eventTypes) {
      textarea.addEventListener(eventType, record, true)
    }
    const onDataDisposable = pane.terminal.onData((data) => {
      onData.push(data)
      onDataEvents.push({ data, timeStamp: performance.now() })
    })
    targetWindow.__terminalImeBoundaryProbe = {
      dom,
      onData,
      onDataEvents,
      dispose: () => {
        for (const eventType of eventTypes) {
          textarea.removeEventListener(eventType, record, true)
        }
        onDataDisposable.dispose()
      }
    }
  })
}

export async function readTerminalImeBoundaryTrace(page: Page): Promise<TerminalImeBoundaryTrace> {
  return page.evaluate(() => {
    const probe = (window as TerminalImeProbeWindow).__terminalImeBoundaryProbe
    // An uninstalled probe returning an empty trace makes every "nothing leaked" negative pass
    // vacuously, so absence must throw rather than read as silence.
    if (!probe) {
      throw new Error('terminal IME boundary probe was never installed')
    }
    return {
      dom: [...probe.dom],
      onData: [...probe.onData],
      onDataEvents: [...(probe.onDataEvents ?? [])]
    }
  })
}

export async function disposeTerminalImeBoundaryProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as TerminalImeProbeWindow
    targetWindow.__terminalImeBoundaryProbe?.dispose()
    delete targetWindow.__terminalImeBoundaryProbe
  })
}

export async function attachTerminalImeBoundaryEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const body = `${JSON.stringify(
    { ...extra, trace: await readTerminalImeBoundaryTrace(page) },
    null,
    2
  )}\n`
  await testInfo.attach(`${name}.json`, {
    body,
    contentType: 'application/json'
  })
  const evidenceDir = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')
  const title = testInfo.title
    .replaceAll(/[^a-z0-9]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase()
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(path.join(evidenceDir, `${name}-${title}.json`), body)
}
