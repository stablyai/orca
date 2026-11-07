// @vitest-environment happy-dom
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  mocks,
  answer,
  mutateWith,
  PROVISIONAL,
  renderOptions,
  descriptor
} from './use-structured-agent-session-options.test-fixture'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const A = 'opencode/crouton-alpha-free'
const B = 'opencode/beam-free'
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection('session-1')
  mocks.effortDiscovery = false
})

it.each([true, false])(
  'discovers a draft-held target only on a capable paired host (%s)',
  async (capable) => {
    mocks.effortDiscovery = capable
    mocks.call.mockReset()
    mocks.hold.mockReset()
    mocks.hold.mockReturnValue(new Promise(() => {}))
    resetHostModelCatalogSnapshotsForTests()
    const makeCatalog = (known: boolean) => ({
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models: [
        { id: A, label: A, isDefault: true, efforts: [{ value: 'high', label: 'High' }] },
        {
          id: B,
          label: B,
          isDefault: false,
          effortsKnown: known ? undefined : false,
          efforts: known
            ? [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' }
              ]
            : []
        }
      ]
    })
    answer({
      modelCatalog: async () => {
        const last = mocks.call.mock.calls.findLast(
          ([, method]) => method === 'agentSession.modelCatalog'
        )
        return makeCatalog(last?.[2]?.selectedModel === B)
      }
    })
    const { mutate } = mutateWith(async () => null)
    const { result } = renderOptions(
      {
        ...PROVISIONAL,
        agent: 'opencode2',
        paired: true,
        launchSeedOptions: { model: A, effort: 'high' }
      },
      mutate
    )
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
    )
    act(() => {
      void result.current.setStructuredOption('model', B)
    })
    await waitFor(() => expect(mocks.hold).toHaveBeenCalled())
    if (capable) {
      await waitFor(() =>
        expect(
          mocks.call.mock.calls.some(
            ([, method, params]) =>
              method === 'agentSession.modelCatalog' && params.selectedModel === B
          )
        ).toBe(true)
      )
      await waitFor(() =>
        expect(descriptor(result.current.optionSnapshot, 'effort')?.kind).toMatchObject({
          choices: [{ value: 'low' }, { value: 'high' }]
        })
      )
    } else {
      expect(
        mocks.call.mock.calls
          .filter(([, method]) => method === 'agentSession.modelCatalog')
          .every(([, , params]) => params.selectedModel === undefined)
      ).toBe(true)
    }
    expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.setOption')).toBe(
      false
    )
  }
)
