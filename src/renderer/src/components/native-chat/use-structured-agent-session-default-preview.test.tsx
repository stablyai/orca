import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_DEFAULT_MODEL_CAPABILITY } from '../../../../shared/agent-session-default-model'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
// @vitest-environment happy-dom
import {
  mocks,
  LOCAL_TARGET,
  PAIRED_TARGET,
  answer,
  mutateWith,
  ATTACHED,
  REOPENED,
  renderOptions,
  descriptor,
  currentValue,
  modelChoiceCount,
  HOST_CATALOG,
  LIVE_OPTIONS
} from './use-structured-agent-session-options.test-fixture'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
describe('useStructuredAgentSessionOptions', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })
  beforeEach(() => {
    mocks.supportsRemote.mockReset().mockResolvedValue(false)
    forgetStructuredSessionSelection('session-1')
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
    mocks.coherentCatalog = false
    resetHostModelCatalogSnapshotsForTests()
  })

  it('carries the host Default preview without replacing the explicit selected model', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_DEFAULT_MODEL_CAPABILITY])
    const defaultModel = {
      id: 'host-original',
      label: 'Host original',
      description: 'Configured model'
    }
    answer({ options: async () => ({ ...LIVE_OPTIONS, defaultModel }) })
    const { result, rerender, unmount } = renderOptions(
      REOPENED,
      mutateWith(async () => null).mutate
    )
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'model')?.defaultChoice).toEqual({
        selected: false,
        model: { value: 'host-original', label: 'Host original', description: 'Configured model' }
      })
    )
    expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
    answer({ options: async () => LIVE_OPTIONS })
    rerender({ ...REOPENED, turnId: 'next-turn' })
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'model')?.defaultChoice).toEqual({
        selected: false
      })
    )
    unmount()
  })

  it.each([false, true])(
    'resets the model on its execution host and clears launch preferences (paired: %s)',
    async (paired) => {
      const capabilities = [
        AGENT_SESSION_DEFAULT_MODEL_CAPABILITY,
        AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
      ]
      setLocalRuntimeCapabilitiesForTests(capabilities)
      mocks.supportsRemote.mockResolvedValue(true)
      let reset = false
      answer({
        options: () =>
          Promise.resolve(
            reset
              ? {
                  ...LIVE_OPTIONS,
                  current: { model: 'gpt-5.5', effort: 'medium', modelDefault: true }
                }
              : LIVE_OPTIONS
          ),
        modelCatalog: () => Promise.resolve(HOST_CATALOG)
      })
      const mutation = mutateWith(async () => {
        reset = true
        return {
          key: 'model',
          value: null,
          modelDefault: true,
          options: { model: 'gpt-5.5', effort: 'medium' }
        }
      })
      const { result } = renderOptions({ ...ATTACHED, paired, isWorking: true }, mutation.mutate)
      await waitFor(() => expect(result.current.optionSurface.resetOption).toBeDefined())
      await act(async () => {
        await result.current.optionSurface.resetOption?.('model')
      })
      expect(mutation.calls).toHaveBeenCalledExactlyOnceWith(
        'agentSession.setOption',
        'agentSession.setOption',
        { key: 'model', value: null }
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.defaultChoice?.selected).toBe(true)
      expect(mocks.enqueue).toHaveBeenCalledWith(paired ? PAIRED_TARGET : LOCAL_TARGET, {
        type: 'clear-model',
        agent: 'codex'
      })
      if (paired) {
        expect(mocks.supportsRemote).toHaveBeenCalledWith(
          'server-1',
          AGENT_SESSION_DEFAULT_MODEL_CAPABILITY
        )
      }
    }
  )

  it('never sends a null reset to an older host', () => {
    setLocalRuntimeCapabilitiesForTests([])
    answer({})
    const mutation = mutateWith(async () => {
      throw new Error('must not write')
    })
    const { result } = renderOptions(REOPENED, mutation.mutate)
    expect(result.current.optionSurface.resetOption).toBeUndefined()
    expect(descriptor(result.current.optionSnapshot, 'model')?.defaultChoice).toBeUndefined()
    expect(mutation.calls).not.toHaveBeenCalled()
  })
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
