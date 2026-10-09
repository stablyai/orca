import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./structured-agent-session-launch-registry', () => ({
  getStructuredLaunchStateBySessionId: () => undefined,
  notifyStructuredLaunchListeners: () => {},
  subscribeStructuredAgentLaunchStatus: () => () => {}
}))

import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'

const TARGET = { kind: 'local' } as const
beforeEach(() => mocks.call.mockReset())

it('holds a published permission pick until the host supplies its fence, then uses the existing writer', async () => {
  let answer: (value: unknown) => void = () => {}
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.history'
      ? new Promise((resolve) => {
          answer = resolve
        })
      : Promise.resolve({ ok: true, value: { options: { permissionMode: 'auto' } } })
  )
  const pick = holdStructuredAgentSessionLaunchOption('chat', 'permissionMode', 'auto', TARGET)
  expect(mocks.call).toHaveBeenCalledTimes(1)
  answer({ ok: true, page: { fence: 7 } })
  await expect(pick).resolves.toEqual({ kind: 'accepted', options: { permissionMode: 'auto' } })
  expect(mocks.call).toHaveBeenLastCalledWith(
    TARGET,
    'agentSession.setOption',
    expect.objectContaining({
      key: 'permissionMode',
      value: 'auto',
      envelope: expect.objectContaining({ expectedRuntimeFence: 7 })
    })
  )
})

it('does not guess a fence when the host cannot supply one', async () => {
  mocks.call.mockResolvedValue({ ok: true, page: {} })
  await expect(
    holdStructuredAgentSessionLaunchOption('chat', 'permissionMode', 'auto', TARGET)
  ).resolves.toMatchObject({ kind: 'refused' })
  expect(mocks.call).toHaveBeenCalledTimes(1)
})
