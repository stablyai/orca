// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environment,
  status
} from '@/components/sidebar/worktree-list/listing/host-status-test-fixtures'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { syncBotHostListing, type BotHostListingInput } from '@/lib/bot-host-listing'

type AvatarReads = {
  reads: string[]
  // What the paired server answers; null while it is away, so the read fails.
  answer: (() => string | null) | null
}
const avatars = vi.hoisted((): AvatarReads => ({ reads: [], answer: null }))

vi.mock('@/lib/bot-catalog', () => ({
  readBotAvatarPng: async (bot: { id: string }) => {
    avatars.reads.push(bot.id)
    if (!avatars.answer) {
      throw new Error('runtime_unavailable')
    }
    return avatars.answer()
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => new Promise(() => {})
}))

import { useBotAvatarLook } from './bot-avatar-image'

const HOST = 'runtime:m4'
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

let nextBot = 0
function mountAvatar(avatar = 'upload:v1', id = `bot-${++nextBot}`) {
  const hook = renderHook(() => useBotAvatarLook({ id, hostId: HOST, avatar }).src)
  return { id, hook }
}

beforeEach(() => {
  avatars.reads = []
  avatars.answer = null
  setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
})

afterEach(() => cleanup())

describe('useBotAvatarLook on a paired server', () => {
  it('shows an uploaded picture once its away server comes back', async () => {
    hostIs(CONNECTED)
    hostIs(DISCONNECTED)
    const { hook } = mountAvatar()
    await flush()
    expect(hook.result.current).toBeNull()

    avatars.answer = () => 'UE5H'
    hostIs(CONNECTED)
    await flush()
    expect(hook.result.current).toBe('data:image/png;base64,UE5H')
  })

  it('reads again after a failed read once the server comes back', async () => {
    hostIs(CONNECTED)
    const { hook } = mountAvatar()
    await flush()
    expect(hook.result.current).toBeNull()

    hostIs(DISCONNECTED)
    avatars.answer = () => 'UE5H'
    hostIs(CONNECTED)
    await flush()
    expect(hook.result.current).toBe('data:image/png;base64,UE5H')
  })

  it('keeps a shown picture, without reading it again, when its server comes back', async () => {
    avatars.answer = () => 'UE5H'
    hostIs(CONNECTED)
    const { id, hook } = mountAvatar()
    await flush()
    expect(hook.result.current).toBe('data:image/png;base64,UE5H')

    avatars.answer = null
    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await flush()
    expect(hook.result.current).toBe('data:image/png;base64,UE5H')
    expect(avatars.reads.filter((read) => read === id)).toHaveLength(1)
  })

  it('reads an empty answer again when the server comes back', async () => {
    avatars.answer = () => null
    hostIs(CONNECTED)
    const { hook } = mountAvatar()
    await flush()
    expect(hook.result.current).toBeNull()

    avatars.answer = () => 'UE5H'
    hostIs(DISCONNECTED)
    hostIs(CONNECTED)
    await flush()
    expect(hook.result.current).toBe('data:image/png;base64,UE5H')
  })

  it('shows a loaded picture in a row mounted while its server is away, without a read', async () => {
    avatars.answer = () => 'UE5H'
    hostIs(CONNECTED)
    const first = mountAvatar()
    await flush()
    expect(first.hook.result.current).toBe('data:image/png;base64,UE5H')
    first.hook.unmount()

    avatars.answer = null
    hostIs(DISCONNECTED)
    const again = mountAvatar('upload:v1', first.id)
    await flush()
    expect(again.hook.result.current).toBe('data:image/png;base64,UE5H')
    expect(avatars.reads.filter((read) => read === first.id)).toHaveLength(1)
  })
})
