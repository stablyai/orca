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
  LIVE_OPTIONS
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
