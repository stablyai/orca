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
const avatars = vi.hoisted(() => ({ reads: [] as Read[] }))

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
  getWindowParkVisible: () => true,
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
})
