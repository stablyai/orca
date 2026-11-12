import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-permission-modes-capability'
// @vitest-environment happy-dom
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import {
  mocks,
  REOPENED,
  answer,
  LIVE_OPTIONS,
  HOST_CATALOG,
  mutateWith,
  renderOptions,
  descriptor,
  modelChoiceCount
} from './session/options/structured/use-structured-agent-session-options.test-fixture'

afterEach(() => setLocalRuntimeCapabilitiesForTests(null))
beforeEach(() => {
  forgetStructuredSessionSelection('session-1')
  mocks.call.mockReset()
  mocks.enqueue.mockReset()
  mocks.hold.mockReset()
  mocks.toastError.mockReset()
  mocks.coherentCatalog = false
  resetHostModelCatalogSnapshotsForTests()
})
describe('future-message option compatibility', () => {
  it.each([false, true])(
    'only allows future-turn picks while busy when the host captures message options (%s)',
    async (supported) => {
      setLocalRuntimeCapabilitiesForTests(
        supported ? [AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY] : []
      )
      answer({
        options: () => Promise.resolve(LIVE_OPTIONS),
        modelCatalog: () => Promise.resolve(HOST_CATALOG)
      })
      const mutation = mutateWith(async () => ({ key: 'model', value: 'gpt-5.6-luna' }))
      const { result } = renderOptions({ ...REOPENED, isWorking: true }, mutation.mutate)
      await waitFor(() =>
        expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(1)
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(supported)
      let accepted = false
      await act(async () => {
        accepted = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(accepted).toBe(supported)
      expect(mutation.calls.mock.calls.length).toBe(supported ? 1 : 0)
      if (!supported) {
        expect(descriptor(result.current.optionSnapshot, 'model')?.disabledReason).toBe(
          'host-update-required'
        )
      }
    }
  )
})

it('keeps a reported permission mode editable while legacy busy model picks are locked', async () => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY])
  answer({
    options: async () => ({
      ...LIVE_OPTIONS,
      current: { ...LIVE_OPTIONS.current, permissionMode: 'ask' }
    }),
    modelCatalog: async () => HOST_CATALOG
  })
  const mutation = mutateWith(async () => ({ key: 'permissionMode', value: 'full-access' }))
  const { result } = renderOptions({ ...REOPENED, isWorking: true }, mutation.mutate)
  await waitFor(() =>
    expect(descriptor(result.current.optionSnapshot, 'permissionMode')?.settable).toBe(true)
  )
  expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(false)
  await act(async () =>
    expect(await result.current.setStructuredOption('permissionMode', 'full-access')).toBe(true)
  )
  expect(mutation.calls).toHaveBeenCalledOnce()
})
