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
}

export type TerminalImeBoundaryTrace = {
  dom: TerminalImeDomEvent[]
  onData: string[]
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
        value: textarea.value
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
    const onDataDisposable = pane.terminal.onData((data) => onData.push(data))
    targetWindow.__terminalImeBoundaryProbe = {
      dom,
      onData,
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
    return probe ? { dom: [...probe.dom], onData: [...probe.onData] } : { dom: [], onData: [] }
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
