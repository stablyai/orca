// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  ATTACHED,
  renderOptions,
  descriptor,
  LIVE_OPTIONS,
  SAVED_LIST,
  tick
} from './use-structured-agent-session-options.test-fixture'
import { act, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/agent-session-permission-modes-capability'

it('keeps known pickers writable after a restarted process options read fails', async () => {
  forgetStructuredSessionSelection('session-1')
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockReset()
  mocks.pick.mockReset()
  mocks.coherentCatalog = true
  mocks.sendSelection = false
  setLocalRuntimeCapabilitiesForTests([
    AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
    AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY
  ])
  const failed = Promise.withResolvers<unknown>()
  let reads = 0
  answer({
    modelCatalog: () => Promise.resolve(SAVED_LIST),
    options: () =>
      ++reads === 1
        ? Promise.resolve({
            ...LIVE_OPTIONS,
            models: LIVE_OPTIONS.models.map((model) => ({
              ...model,
              efforts: [{ value: 'medium', label: 'Medium' }]
            })),
            current: { ...LIVE_OPTIONS.current, effort: 'medium', permissionMode: 'ask' }
          })
        : failed.promise
  })
  const { result, rerender, unmount } = renderOptions(ATTACHED, mutateWith(async () => null).mutate)
  try {
    await waitFor(() =>
      expect(result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
    )
    const beforeRestart = reads
    rerender({ ...ATTACHED, fence: 2 })
    await act(async () => {
      failed.reject(new Error('host timeout'))
      await tick()
    })
    await waitFor(() => expect(reads).toBe(beforeRestart + 3))
    for (const id of ['model', 'effort', 'permissionMode']) {
      expect(descriptor(result.current.optionSnapshot, id)?.settable, id).toBe(true)
    }
    mocks.pick.mockResolvedValue({
      key: 'model',
      value: 'gpt-5.6-luna',
      options: { model: 'gpt-5.6-luna' }
    })
    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
    })
    expect(applied).toBe(true)
    expect(mocks.pick).toHaveBeenCalled()
  } finally {
    unmount()
    forgetStructuredSessionSelection('session-1')
    setLocalRuntimeCapabilitiesForTests(null)
  }
})
