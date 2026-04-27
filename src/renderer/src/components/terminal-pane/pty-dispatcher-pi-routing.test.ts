// Why: reproduce the renderer-level Pi spinner pipeline from the
// `pty:data` IPC event all the way down to onTitleChange. The electron
// verification showed spinner frames arrive via IPC but the store never sees
// "⠋ Pi" — this file pins the integration between the singleton dispatcher
// and the transport's per-pty handler.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

describe('dispatcher → transport → onTitleChange for Pi spinner', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  // The singleton dispatcher subscribes a SINGLE global `window.api.pty.onData`
  // callback on first `ensurePtyDispatcher()`. We simulate the main process
  // delivering IPC events by invoking that captured callback directly.
  let dispatcherCallback: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    dispatcherCallback = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((cb: (payload: { id: string; data: string }) => void) => {
            // Only the first subscriber wins in production — the dispatcher
            // calls onData exactly once (ensurePtyDispatcher guards with the
            // `ptyDispatcherAttached` flag). Subsequent transport calls go
            // through the same cached subscription, so we capture the first
            // one and ignore the rest.
            if (!dispatcherCallback) {
              dispatcherCallback = cb
            }
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('routes Pi OSC title frames from pty:data → onTitleChange via the dispatcher', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    expect(dispatcherCallback).not.toBeNull()

    // Simulate the main process firing `pty:data` IPC for pty-pi. The
    // dispatcher looks up `ptyDataHandlers.get('pty-pi')` and calls it with
    // the data — the same path exercised by a real Pi session.
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠙') })
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('pipeline survives a chunk carrying shell output interleaved with spinner frames', async () => {
    // Why: node-pty batches at 8ms on the main side, so the renderer often
    // sees multiple OSC sequences and body bytes in one chunk. The transport
    // handler extracts the LAST OSC title in each chunk — working frames that
    // land as the last title in any chunk must surface through onTitleChange.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({
      id: 'pty-pi',
      data: `assistant output line 1\r\n${workingFrame('⠋')}more body text`
    })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('attach()-flow pipeline delivers working frames to onTitleChange', async () => {
    // Why: the reattach code path (daemon-backed or intra-session remount)
    // calls transport.attach() instead of transport.connect(). If the handler
    // registration drifted between the two paths, Pi sessions restored after
    // a tab remount would stop emitting spinner signals — consistent with
    // the electron-level observation where poll-sampled runtimePaneTitlesByTabId
    // never flipped to "⠋ Pi" during a live working window.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    transport.attach({ existingPtyId: 'pty-pi', callbacks: {} })

    // Eager-buffer replay in attach() can flush initial titles through the
    // same handler; only assert about frames we push AFTER attach resolves.
    onTitleChange.mockClear()

    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('reproduces "Pi is idle" state: after working→idle, onTitleChange ends on Pi', async () => {
    // Why: the user-visible bug is that the store shows "Pi" (idle) even
    // during working — meaning intermediate "⠋ Pi" updates never landed OR
    // they landed and were then overwritten and dedupe-filtered. Assert that
    // BOTH labels reach onTitleChange during a working→idle cycle, in order.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠙') })
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    const workingIdx = seenTitles.findIndex((t) => t === '⠋ Pi')
    const finalIdleIdx = seenTitles.lastIndexOf('Pi')
    expect(workingIdx).toBeGreaterThanOrEqual(0)
    expect(finalIdleIdx).toBeGreaterThan(workingIdx)

    transport.disconnect()
  })

  // Why: regression test for the cursor spinner "solid after 500ms" bug.
  // cursor-agent re-emits its native `OSC 0: "Cursor Agent"` title on every
  // internal redraw mid-turn. Orca's main process injects synthesized
  // "⠋ Cursor Agent" spinner frames from the hook server; the renderer must
  // drop cursor's bare native title so it cannot overwrite the synthesized
  // working title in `runtimePaneTitlesByTabId` (which drives `getWorktreeStatus`'s
  // solid/spinning dot decision). If the bare title leaked through, the last
  // title in the store would flip to "Cursor Agent" (which `detectAgentStatusFromTitle`
  // classifies as null / not-working) and the sidebar would snap solid
  // mid-turn.
  it('drops cursor-agent native "Cursor Agent" title so it cannot overwrite the synthesized spinner', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // Simulate the realistic interleave: Orca injects a synthesized working
    // frame, cursor-agent re-emits its bare native title shortly after, Orca
    // injects the next spinner frame, etc.
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠋ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠙ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    // The two bare "Cursor Agent" titles must NOT reach the title-change
    // pipeline. The two synthesized spinner frames must.
    expect(seenTitles).not.toContain('Cursor Agent')
    expect(seenTitles).toContain('⠋ Cursor Agent')
    expect(seenTitles).toContain('⠙ Cursor Agent')

    transport.disconnect()
  })

  it('still surfaces the synthesized "Cursor ready" idle title after working', async () => {
    // Why: make sure the bare-title drop does not accidentally catch the
    // decorated "Cursor ready" done frame Orca synthesizes on the `stop` hook.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠋ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor ready${BEL}${BEL}` })

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Cursor Agent')
    expect(seenTitles).toContain('Cursor ready')

    transport.disconnect()
  })
})
