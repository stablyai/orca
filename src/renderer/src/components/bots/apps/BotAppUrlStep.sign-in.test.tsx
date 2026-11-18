// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('../AddBotToolDialog', () => ({ LoadedEditor: () => null }))

import { CustomAppStep } from './BotAppUrlStep'
import { resetBotToolSignInsForTest } from '../bot-tools-client'
import { BotSchema } from '../../../../../shared/bot-types'

const bot = BotSchema.parse({
  id: 'bot-1',
  name: 'Scout',
  folder: 'scout',
  folderWorkspaceId: 'home',
  agent: 'claude',
  hostId: 'local',
  avatar: 'mascot:A1',
  paused: false,
  slack: null,
  members: [],
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  chatSessionId: 'home-session',
  createdAt: 1,
  updatedAt: 1
})
const preset = {
  name: 'context7',
  title: 'Context7',
  url: 'https://mcp.context7.com/mcp',
  logo: null
}

describe('Add Context7: Orca-owned sign-in on this computer', () => {
  let progress: 'waiting' | 'done'
  beforeEach(() => {
    vi.useFakeTimers()
    progress = 'waiting'
    mocks.rpc.mockReset().mockImplementation(async (_t: unknown, method: string) => {
      switch (method) {
        case 'bots.tools.add':
          return {
            tool: {
              name: 'context7',
              detail: preset.url,
              remote: true,
              signIn: { state: 'signed-out' }
            }
          }
        case 'bots.tools.connect':
          return { attemptId: 'a-1', authorizationOrigin: 'https://context7.com' }
        case 'bots.tools.signInStatus':
          return {
            status: progress === 'done' ? 'done' : 'pending',
            progress: { state: progress }
          }
        default:
          return {}
      }
    })
    Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  })
  afterEach(() => {
    cleanup()
    resetBotToolSignInsForTest()
    vi.useRealTimers()
  })

  it('leaves Finish in your browser once the host says the sign-in is done', async () => {
    render(<CustomAppStep bot={bot} preset={preset} onBack={() => {}} onClose={() => {}} />)
    await act(() => vi.advanceTimersByTimeAsync(2_100))
    expect(screen.getByText('Finish in your browser')).toBeTruthy()

    progress = 'done'
    await act(() => vi.advanceTimersByTimeAsync(4_100))
    expect(screen.queryByText('Finish in your browser')).toBeNull()
    expect(screen.getByText('Context7 is on Scout')).toBeTruthy()
  })
})
