// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted((): { activeWorktreeId: string | null } => ({ activeWorktreeId: 'wt-a' }))
vi.mock('@/store/index', () => ({
  useAppStore: (select: (state: typeof store) => unknown) => select(store)
}))

import { usePluginDeclarativeState } from './use-plugin-declarative-state'

type PanelStateArgs = {
  op: string
  workspace?: string | null
  entries?: { scope: string; value: unknown }[]
}
const panelState = vi.fn<(args: PanelStateArgs) => Promise<unknown>>()

function lastHydration(hydrations: (number | undefined)[]): number {
  const last = hydrations.at(-1)
  if (last === undefined) {
    throw new Error('no numbered hydrate was sent')
  }
  return last
}

function hydrationOf(payload: unknown): number | undefined {
  return typeof payload === 'object' &&
    payload !== null &&
    'hydration' in payload &&
    typeof payload.hydration === 'number'
    ? payload.hydration
    : undefined
}

/** A panel whose guest sent `ui.ready` and got its first hydrate, in `wt-a`. */
async function mountReadyPanel() {
  const sendToGuest = vi.fn()
  const { result, rerender } = renderHook(() =>
    usePluginDeclarativeState({ panelId: 'p', sessionToken: 'tok', visible: true, sendToGuest })
  )
  const hydrations = (): (number | undefined)[] =>
    sendToGuest.mock.calls
      .filter(([event]) => event === 'ui.hydrate')
      .map(([, payload]) => hydrationOf(payload))
  act(() => result.current.onGuestEvent('ui.ready', { document: 'doc' }))
  await waitFor(() => expect(hydrations()).toHaveLength(1))
  return {
    first: lastHydration(hydrations()),
    async switchTo(workspace: string): Promise<number> {
      const before = hydrations().length
      store.activeWorktreeId = workspace
      rerender()
      await waitFor(() => expect(hydrations()).toHaveLength(before + 1))
      return lastHydration(hydrations())
    },
    persist(entry: { hydration?: number; scope?: string; value: string }): void {
      const { hydration, scope = 'workspace', value } = entry
      act(() =>
        result.current.onGuestEvent('ui.persist', {
          document: 'doc',
          ...(hydration === undefined ? {} : { hydration }),
          entries: [{ scope, key: 'draft', version: 1, value }]
        })
      )
    },
    writes: (): PanelStateArgs[] =>
      panelState.mock.calls.map(([args]) => args).filter((args) => args.op === 'write'),
    stored: (): [string | null, unknown][] =>
      panelState.mock.calls
        .map(([args]) => args)
        .filter((args) => args.op === 'write')
        .map((args) => [args.workspace ?? null, args.entries?.[0]?.value])
  }
}

beforeEach(() => {
  store.activeWorktreeId = 'wt-a'
  panelState.mockReset()
  panelState.mockImplementation(async (args: { op: string }) =>
    args.op === 'read' ? { ok: true, state: { plugin: {}, workspace: {} } } : { ok: true }
  )
  vi.stubGlobal('api', { plugins: { panelState } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('usePluginDeclarativeState', () => {
  it('keeps each write with its own workspace across a quick A, B, A switch', async () => {
    const panel = await mountReadyPanel()
    const inB = await panel.switchTo('wt-b')
    const secondA = await panel.switchTo('wt-a')
    panel.persist({ hydration: panel.first, value: 'first A' })
    panel.persist({ hydration: inB, value: 'B' })
    panel.persist({ hydration: secondA, value: 'second A' })
    expect(panel.stored()).toEqual([
      ['wt-a', 'first A'],
      ['wt-b', 'B'],
      ['wt-a', 'second A']
    ])
  })

  it('stores a write without a hydration (an older guest runtime) under the active workspace', async () => {
    const panel = await mountReadyPanel()
    await panel.switchTo('wt-b')
    panel.persist({ value: 'legacy' })
    expect(panel.stored()).toEqual([['wt-b', 'legacy']])
  })

  it('remembers the last eight hydrations and drops a write naming an older or unknown one', async () => {
    const panel = await mountReadyPanel()
    let latest = panel.first
    for (let index = 0; index < 9; index += 1) {
      latest = await panel.switchTo(index % 2 === 0 ? 'wt-b' : 'wt-a')
    }
    // Eight back (made in wt-b) is still known; nine back (the first, in wt-a) is not.
    panel.persist({ hydration: latest - 8, value: 'eight back' })
    panel.persist({ hydration: panel.first, value: 'nine back' })
    panel.persist({ hydration: latest + 1, value: 'never sent' })
    expect(panel.stored()).toEqual([['wt-b', 'eight back']])
  })
})
