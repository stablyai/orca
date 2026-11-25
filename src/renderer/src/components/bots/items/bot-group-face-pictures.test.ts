// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environment,
  status
} from '@/components/sidebar/worktree-list/listing/host-status-test-fixtures'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import {
  emitPairedBotsStreamCameBack,
  syncBotHostListing,
  type BotHostListingInput
} from '@/lib/bot-host-listing'

type Read = { botId: string; settle: (png: string | null | Error) => void }
const avatars = vi.hoisted((): { reads: Read[] } => ({ reads: [] }))
// Whether the window says it is shown; after display wake it can say hidden while it is not.
const windowPark = vi.hoisted(() => ({ visible: true }))

// Each avatar read waits until the test answers it, so reads from before and after a come-back can be
// answered in any order.
vi.mock('@/lib/bot-catalog', () => ({
  readBotAvatarPng: (bot: { id: string }) =>
    new Promise<string | null>((resolve, reject) => {
      avatars.reads.push({
        botId: bot.id,
        settle: (png) => (png instanceof Error ? reject(png) : resolve(png))
      })
    })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => new Promise(() => {})
}))
vi.mock('@/lib/window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => windowPark.visible,
  subscribeWindowParkVisibility: () => () => {}
}))

import { useBotAvatarLook } from '../bot-avatar-image'
import { useBotGroupFacePictures } from './bot-group-face-pictures'

const HOST = 'runtime:m4'
const VERSION = 'v1'
const PNG = 'data:image/png;base64,UE5H'
const CONNECTED: RuntimeEnvironmentStatus = {
  status: { ...status('runtime'), capabilities: ['bots.mobile.v1'] },
  checkedAt: 1
}
const DISCONNECTED: RuntimeEnvironmentStatus = { status: null, checkedAt: 1 }

function hostIs(entry: RuntimeEnvironmentStatus): void {
  const input: BotHostListingInput = {
    runtimeEnvironments: [environment('m4')],
    folderWorkspaces: [],
    runtimeEnvironmentCatalogHydrated: false,
    runtimeStatusByEnvironmentId: new Map([['m4', entry]])
  }
  act(() => syncBotHostListing(input, false))
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

async function answer(read: Read | undefined, png: string | null | Error): Promise<void> {
  expect(read).toBeDefined()
  read!.settle(png)
  await flush()
}

let nextBot = 0
/** An Items panel with one row face drawn for a fresh bot; `header` mounts that bot's header avatar. */
function mountPanelRow() {
  const id = `bot-${++nextBot}`
  const panel = renderHook(() => useBotGroupFacePictures())
  const face = panel.result.current.faceOf({ hostId: HOST, id }, VERSION)
  let unsubscribe = (): void => {}
  act(() => {
    unsubscribe = face.subscribe(() => {})
  })
  const mountHeader = () =>
    renderHook(() => useBotAvatarLook({ id, hostId: HOST, avatar: `upload:${VERSION}` }).src)
  return {
    id,
    row: () => face.read(),
    readsOf: () => avatars.reads.filter((read) => read.botId === id),
    mountHeader,
    unmount: () => {
      unsubscribe()
      panel.unmount()
    }
  }
}

beforeEach(() => {
  avatars.reads = []
  windowPark.visible = true
  setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
})

afterEach(() => cleanup())

describe('group Items row faces on a paired server', () => {
  it('reads an empty answer again when the server comes back, without Back or reopen', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    await answer(panel.readsOf()[0], null)
    expect(panel.row()).toBeNull()

    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await answer(panel.readsOf()[1], 'UE5H')
    expect(panel.row()).toBe(PNG)
    expect(panel.readsOf()).toHaveLength(2)
    panel.unmount()
  })

  it('reads a failed picture again when the server comes back, without Back or reopen', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    await answer(panel.readsOf()[0], new Error('runtime_unavailable'))
    expect(panel.row()).toBeNull()

    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await answer(panel.readsOf()[1], 'UE5H')
    expect(panel.row()).toBe(PNG)
    panel.unmount()
  })

  it('reads again when only the event stream comes back, the listing unchanged', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    await answer(panel.readsOf()[0], null)

    act(() => emitPairedBotsStreamCameBack('m4'))
    await answer(panel.readsOf()[1], 'UE5H')
    expect(panel.row()).toBe(PNG)
    panel.unmount()
  })

  it('takes the picture a header read, while the row shows its initial', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    await answer(panel.readsOf()[0], new Error('runtime_unavailable'))
    expect(panel.row()).toBeNull()

    const header = panel.mountHeader()
    await answer(panel.readsOf()[1], 'UE5H')
    expect(header.result.current).toBe(PNG)
    expect(panel.row()).toBe(PNG)
    panel.unmount()
  })

  it('keeps the current picture when a read from before the come-back answers late', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    const before = panel.readsOf()[0]

    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    const header = panel.mountHeader()
    await flush()
    // The row's and the header's reads after the come-back are one read.
    expect(panel.readsOf()).toHaveLength(2)
    await answer(panel.readsOf()[1], 'UE5H')
    expect(header.result.current).toBe(PNG)
    expect(panel.row()).toBe(PNG)

    await answer(before, null)
    expect(panel.row()).toBe(PNG)
    expect(header.result.current).toBe(PNG)
    const third = panel.mountHeader()
    await flush()
    expect(third.result.current).toBe(PNG)
    expect(panel.readsOf()).toHaveLength(2)
    panel.unmount()
  })

  it('sends one read on come-back for a row that waited offline and a header', async () => {
    hostIs(CONNECTED)
    hostIs(DISCONNECTED)
    const panel = mountPanelRow()
    const header = panel.mountHeader()
    await flush()
    expect(panel.readsOf()).toHaveLength(0)

    hostIs(CONNECTED)
    await flush()
    expect(panel.readsOf()).toHaveLength(1)
    await answer(panel.readsOf()[0], 'UE5H')
    expect(panel.row()).toBe(PNG)
    expect(header.result.current).toBe(PNG)
    panel.unmount()
  })

  it('keeps a picture read before a come-back when the read after it fails', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    const before = panel.readsOf()[0]

    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await flush()
    const after = panel.readsOf()[1]
    await answer(before, 'UE5H')
    await answer(after, new Error('runtime_unavailable'))

    // The version names the bytes, so the picture read before still serves a new view.
    const third = panel.mountHeader()
    await flush()
    expect(third.result.current).toBe(PNG)
    expect(panel.readsOf()).toHaveLength(2)
    panel.unmount()
  })

  // A read held over the come-back (A) and the read after it (B), answered in either order: a picture
  // from either reaches every face already drawn, and the other's empty or failed answer never hides it.
  for (const negative of [null, new Error('runtime_unavailable')]) {
    for (const order of ['before first', 'after first'] as const) {
      it(`shows the picture in a drawn row and header when the ${order === 'before first' ? 'read from before' : 'read after'} the come-back answers first (${negative === null ? 'empty' : 'failed'})`, async () => {
        hostIs(CONNECTED)
        const panel = mountPanelRow()
        const header = panel.mountHeader()
        await flush()
        expect(panel.readsOf()).toHaveLength(1)
        const before = panel.readsOf()[0]

        hostIs(DISCONNECTED)
        hostIs(CONNECTED)
        await flush()
        expect(panel.readsOf()).toHaveLength(2)
        const after = panel.readsOf()[1]
        if (order === 'before first') {
          await answer(before, 'UE5H')
          await answer(after, negative)
        } else {
          await answer(after, negative)
          await answer(before, 'UE5H')
        }
        expect(panel.row()).toBe(PNG)
        expect(header.result.current).toBe(PNG)

        const third = panel.mountHeader()
        await flush()
        expect(third.result.current).toBe(PNG)
        expect(panel.readsOf()).toHaveLength(2)
        panel.unmount()
      })
    }
  }

  it('keeps a shown picture when an older version takes the cache slot and the read after the come-back answers empty', async () => {
    hostIs(CONNECTED)
    const panel = mountPanelRow()
    const header = panel.mountHeader()
    await flush()
    const before = panel.readsOf()[0]

    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await flush()
    expect(panel.readsOf()).toHaveLength(2)
    const after = panel.readsOf()[1]
    await answer(before, 'UE5H')
    expect(panel.row()).toBe(PNG)
    expect(header.result.current).toBe(PNG)

    // Earlier chat history draws the same bot with the picture it had then: that read takes the
    // bot's one cache slot while the current pair still shows the newer version.
    const history = renderHook(
      () => useBotAvatarLook({ id: panel.id, hostId: HOST, avatar: 'upload:v0' }).src
    )
    await flush()
    expect(panel.readsOf()).toHaveLength(3)

    await answer(after, null)
    expect(header.result.current).toBe(PNG)
    expect(panel.row()).toBe(PNG)
    history.unmount()
    panel.unmount()
  })

  it('shows a picture a newly drawn row reads in a header whose own read failed', async () => {
    hostIs(CONNECTED)
    const first = mountPanelRow()
    const header = first.mountHeader()
    await answer(first.readsOf()[0], new Error('runtime_unavailable'))
    expect(header.result.current).toBeNull()
    expect(first.row()).toBeNull()

    // Another panel draws the same member's face in the same come-back and reads it.
    const panel = renderHook(() => useBotGroupFacePictures())
    const face = panel.result.current.faceOf({ hostId: HOST, id: first.id }, VERSION)
    act(() => {
      face.subscribe(() => {})
    })
    await answer(first.readsOf()[1], 'UE5H')
    expect(face.read()).toBe(PNG)
    expect(header.result.current).toBe(PNG)
    expect(first.row()).toBe(PNG)
    expect(first.readsOf()).toHaveLength(2)
    first.unmount()
    panel.unmount()
  })

  it('keeps a row read started as the server comes back, while the window wrongly says hidden', async () => {
    windowPark.visible = false
    hostIs(CONNECTED)
    hostIs(DISCONNECTED)
    const panel = mountPanelRow()
    // A scroll over the panel proves the window is shown though it says hidden.
    act(() => {
      document.dispatchEvent(new Event('wheel'))
    })
    expect(panel.readsOf()).toHaveLength(0)

    hostIs(CONNECTED)
    await flush()
    expect(panel.readsOf()).toHaveLength(1)
    await answer(panel.readsOf()[0], new Error('runtime_unavailable'))
    expect(panel.row()).toBeNull()

    // With no come-back since, a failed read waits for Back or reopen, not the next scroll.
    act(() => {
      document.dispatchEvent(new Event('wheel'))
    })
    await flush()
    expect(panel.readsOf()).toHaveLength(1)
    panel.unmount()
  })
})
