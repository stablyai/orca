// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => [
    { id: 'bot-elsewhere', agent: 'claude' },
    { id: 'bot-checking', agent: 'claude' }
  ]
}))

import { useBotTools } from './bot-tool-checks'

afterEach(cleanup)

it('shows a sign-in state another window or the host changed, open or reopened', async () => {
  let failed = false
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method !== 'bots.tools.list') {
      throw new Error(method)
    }
    const signIn = failed
      ? { state: 'signed-out', problem: 'unsupported' }
      : { state: 'signed-out' }
    return {
      agent: 'claude',
      own: [{ name: 'app', detail: 'https://app.example/mcp', remote: false, signIn }],
      inherited: []
    }
  })
  const unsupported = {
    status: 'ready',
    tools: { own: [{ signIn: { state: 'signed-out', problem: 'unsupported' } }] }
  }
  const open = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-elsewhere' }, 'none'))
  await waitFor(() => expect(open.result.current.view).toMatchObject({ status: 'ready' }))

  failed = true
  await act(async () => {
    emitBotsChangedWindowEvent('local')
  })

  await waitFor(() => expect(open.result.current.view).toMatchObject(unsupported))
  open.unmount()
  const reopened = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-elsewhere' }, 'none'))
  await waitFor(() => expect(reopened.result.current.view).toMatchObject(unsupported))
})

it('keeps a sign-in read again while a check was under way when the check finishes', async () => {
  let failed = false
  const check = Promise.withResolvers<{ problems: Record<string, never> }>()
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'bots.tools.problems') {
      return check.promise
    }
    if (method === 'bots.tools.cancelProblems') {
      return {}
    }
    if (method !== 'bots.tools.list') {
      throw new Error(method)
    }
    const signIn = failed
      ? { state: 'signed-out', problem: 'unsupported' }
      : { state: 'signed-out' }
    return {
      agent: 'claude',
      own: [{ name: 'app', detail: 'https://app.example/mcp', remote: false, signIn }],
      inherited: []
    }
  })
  const unsupported = {
    status: 'ready',
    tools: { own: [{ signIn: { state: 'signed-out', problem: 'unsupported' } }] }
  }
  // Settings › Tools checks every server, so a check runs while the list is read again.
  const open = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-checking' }, 'check'))
  await waitFor(() => expect(open.result.current.view).toMatchObject({ status: 'ready' }))
  failed = true
  await act(async () => {
    emitBotsChangedWindowEvent('local')
  })
  await waitFor(() => expect(open.result.current.view).toMatchObject(unsupported))

  await act(async () => {
    check.resolve({ problems: {} })
    await check.promise
  })

  expect(open.result.current.view).toMatchObject({ ...unsupported, problems: {} })
  open.unmount()
  const reopened = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-checking' }, 'check'))
  await waitFor(() => expect(reopened.result.current.view).toMatchObject(unsupported))
})
