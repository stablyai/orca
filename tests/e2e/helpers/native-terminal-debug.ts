import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { waitForPtyShellEcho } from '../terminal-pty-readiness'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './terminal'

// Main installs these hooks in unpackaged builds (installNativeTerminalDebugHooks).
export type NativeTerminalDebugOp =
  | 'surfaceIds'
  | 'state'
  | 'grid'
  | 'screenText'
  | 'snapshotBase64'
  | 'key'
  | 'focus'
  | 'modifiersChanged'
  | 'drop'
  | 'dropOutcome'
  | 'forwardedChords'
  | 'action'
  | 'flags'
  | 'insertText'
  | 'markedText'
  | 'imeRect'
  | 'services'
  | 'accessibility'
  | 'accessibilitySet'
  | 'secureInput'
  | 'textInputMenu'
  | 'mainFeed'
  | 'counters'
  | 'windowOcclusion'

export const RETURN_KEY_CODE = 0x24

export function nativeTerminalDebug(
  app: ElectronApplication,
  op: NativeTerminalDebugOp,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(
    (_electron, [name, callArgs]) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const fn: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, name) : null
      if (typeof fn !== 'function') {
        throw new Error(`native terminal debug hook ${name} is not installed`)
      }
      return Reflect.apply(fn, debug, callArgs)
    },
    [op, args] as const
  )
}

export async function nativeSurfaceIds(app: ElectronApplication): Promise<number[]> {
  const ids = await nativeTerminalDebug(app, 'surfaceIds')
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

export async function nativeSurfaceField(
  app: ElectronApplication,
  surfaceId: number,
  field: string
): Promise<unknown> {
  const state = await nativeTerminalDebug(app, 'state', [surfaceId])
  return typeof state === 'object' && state !== null ? Reflect.get(state, field) : null
}

export async function nativeScreenText(
  app: ElectronApplication,
  surfaceId: number
): Promise<string> {
  const text = await nativeTerminalDebug(app, 'screenText', [surfaceId])
  return typeof text === 'string' ? text : ''
}

export async function isNativeSurfaceHidden(
  app: ElectronApplication,
  surfaceId: number
): Promise<boolean | null> {
  const state = await nativeTerminalDebug(app, 'state', [surfaceId])
  const hidden: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'hidden') : null
  return typeof hidden === 'boolean' ? hidden : null
}

export async function nativeGridSize(
  app: ElectronApplication,
  surfaceId: number
): Promise<{ columns: number; rows: number } | null> {
  const grid = await nativeTerminalDebug(app, 'grid', [surfaceId])
  if (typeof grid !== 'object' || grid === null) {
    return null
  }
  const columns = Number(Reflect.get(grid, 'columns'))
  const rows = Number(Reflect.get(grid, 'rows'))
  return Number.isFinite(columns) && Number.isFinite(rows) ? { columns, rows } : null
}

// The `.xterm-screen` transform the render pause applies while the native view covers a pane.
export function xtermScreenTransform(page: Page, ptyId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const screen = document.querySelector<HTMLElement>(`.pane[data-pty-id="${id}"] .xterm-screen`)
    return screen ? screen.style.transform : null
  }, ptyId)
}

export async function enableNativeTerminal(page: Page, enabled = true): Promise<void> {
  await page.evaluate(async (value) => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: value })
  }, enabled)
}

// The native surface drawing this pane (its terminal box carries data-native-surface-id).
export async function findNativeSurfaceForPane(
  page: Page,
  ptyId: string,
  timeoutMs = 15_000
): Promise<number | null> {
  const read = (): Promise<number> =>
    page.evaluate(
      (id) =>
        Number(
          document.querySelector<HTMLElement>(`.pane[data-pty-id="${id}"] [data-native-surface-id]`)
            ?.dataset.nativeSurfaceId ?? 0
        ),
      ptyId
    )
  const deadline = Date.now() + timeoutMs
  for (let surfaceId = await read(); ; surfaceId = await read()) {
    if (surfaceId > 0 || Date.now() >= deadline) {
      return surfaceId > 0 ? surfaceId : null
    }
    await page.waitForTimeout(100)
  }
}

// Splits the active pane (the setting must already be on) and waits for its native surface.
export async function splitNativeTerminalPane(
  page: Page,
  app: ElectronApplication
): Promise<{ ptyId: string; surfaceId: number }> {
  const previousPtyId = await waitForActivePanePtyId(page)
  await splitActiveTerminalPane(page, 'vertical')
  await waitForActiveTerminalManager(page, 30_000)
  let ptyId = previousPtyId
  await expect
    .poll(async () => (ptyId = await waitForActivePanePtyId(page)), { timeout: 15_000 })
    .not.toBe(previousPtyId)
  await waitForPtyShellEcho(page, ptyId, 30_000)
  const surfaceId = await findNativeSurfaceForPane(page, ptyId)
  if (surfaceId === null) {
    throw new Error(`no native terminal surface shows the new pane ${ptyId}`)
  }
  await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
  return { ptyId, surfaceId }
}

// Polls until the native grid holds still, so later comparisons see a settled layout.
export async function settledNativeGrid(
  app: ElectronApplication,
  surfaceId: number
): Promise<{ columns: number; rows: number }> {
  const latest: { key: string; grid: { columns: number; rows: number } | null } = {
    key: '',
    grid: null
  }
  await expect
    .poll(
      async () => {
        const grid = await nativeGridSize(app, surfaceId)
        const key = JSON.stringify(grid)
        const stable = grid !== null && key === latest.key
        latest.key = key
        latest.grid = grid
        return stable
      },
      { timeout: 15_000, intervals: [300] }
    )
    .toBe(true)
  if (!latest.grid) {
    throw new Error(`native surface ${surfaceId} has no grid`)
  }
  return latest.grid
}
