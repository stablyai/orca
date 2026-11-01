// @vitest-environment happy-dom
import { act, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import {
  mocks,
  answer,
  mutateWith,
  REOPENED,
  renderOptions,
  currentValue,
  descriptor,
  LOCAL_TARGET,
  LIVE_OPTIONS,
  PROVISIONAL,
  SAVED_LIST,
  SEED,
  tick
} from './use-structured-agent-session-options.test-fixture'
import { structuredSessionSelectionController } from '@/lib/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

beforeEach(() => {
  mocks.call.mockReset()
  mocks.pick.mockReset()
  mocks.enqueue.mockReset()
  mocks.hold.mockReset()
  mocks.toastError.mockReset()
  mocks.coherentCatalog = false
  resetHostModelCatalogSnapshotsForTests()
})

it('rereads a superseded write without holding another option row', async () => {
  let reads = 0
  answer({
    options: async () => {
      reads += 1
      return LIVE_OPTIONS
    }
  })
  const reply = Promise.withResolvers<unknown>()
  const { mutate } = mutateWith(() => reply.promise)
  const { result, unmount } = renderOptions(REOPENED, mutate)
  await waitFor(() => expect(reads).toBe(1))
  let picking!: Promise<boolean>
  act(() => {
    picking = result.current.setStructuredOption('model', 'raw-alias')
  })
  expect(currentValue(result.current.optionSnapshot, 'model')).toBe('raw-alias')
  expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
  const controller = structuredSessionSelectionController(LOCAL_TARGET, 'session-1', 'codex')
  const operation = controller.current('model')!
  await act(async () => {
    controller.settle(operation, { kind: 'superseded' })
    expect(await picking).toBe(true)
  })
  await waitFor(() => expect(reads).toBe(2))
  reply.resolve({ options: {} })
  unmount()
})

const CAPACITY_TOAST =
  "The setting wasn't changed. Orca on the computer running this chat has hit a request limit. Update Orca there, then try again."

it('reports a held launch refusal while the transport is still closed', async () => {
  answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
  mocks.hold.mockResolvedValue({
    kind: 'refused',
    failure: { kind: 'refused', code: 'agent_session_operation_capacity' }
  })
  const { result, unmount } = renderOptions(
    { ...PROVISIONAL, launchSeedOptions: SEED, presentation: true },
    mutateWith(async () => null).mutate
  )
  await waitFor(() =>
    expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
  )
  await act(async () => {
    expect(await result.current.setStructuredOption('model', 'gpt-5.6-luna')).toBe(true)
  })
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(CAPACITY_TOAST))
  await tick()
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
  unmount()
})

it('reports a refusal on the same chat after its runtime fence changes', async () => {
  let reads = 0
  answer({
    options: async () => {
      reads += 1
      return LIVE_OPTIONS
    }
  })
  const readsAnswer = mocks.call.getMockImplementation()!
  const reply = Promise.withResolvers<unknown>()
  mocks.call.mockImplementation((...args: unknown[]) =>
    args[1] === 'agentSession.setOption' ? reply.promise : readsAnswer(...args)
  )
  const props = { ...REOPENED, presentation: true }
  const { result, rerender, unmount } = renderOptions(props, mutateWith(async () => null).mutate)
  await waitFor(() => expect(reads).toBe(1))
  let picking!: Promise<boolean>
  act(() => {
    picking = result.current.setStructuredOption('model', 'gpt-5.6-luna')
  })
  rerender({ ...props, fence: 2 })
  await act(async () => {
    reply.resolve({ ok: false, refusal: { code: 'agent_session_operation_capacity' } })
    expect(await picking).toBe(false)
  })
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
  expect(mocks.toastError).toHaveBeenCalledWith(CAPACITY_TOAST)
  unmount()
})
