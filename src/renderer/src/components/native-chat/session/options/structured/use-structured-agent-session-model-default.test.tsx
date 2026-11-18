// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  ATTACHED,
  LIVE_OPTIONS,
  descriptor,
  renderOptions
} from './use-structured-agent-session-options.test-fixture'
import { seededByNextLaunch } from './structured-session-option-defaults.test-fixture'
import { act, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'

it('returns the chat and later new chats to the agent default, even after an effort pick', async () => {
  forgetStructuredSessionSelection('session-1')
  mocks.call.mockReset()
  mocks.enqueue.mockReset()
  mocks.sendSelection = true
  mocks.defaultModel = true
  let reset = false
  const current = { ...LIVE_OPTIONS.current, acceptedInputSources: { model: 'saved' } }
  // Later reads stay unanswered: what the reset itself commits must already send no model.
  answer({
    options: () => (reset ? new Promise(() => {}) : Promise.resolve({ ...LIVE_OPTIONS, current }))
  })
  const { mutate } = mutateWith(async (_method, _fingerprint, fields) => {
    if (!fields || typeof fields !== 'object' || !('key' in fields) || !('value' in fields)) {
      return null
    }
    if (fields.value === null) {
      reset = true
      return { ...fields, modelDefault: true, options: {} }
    }
    return { ...fields, options: { [String(fields.key)]: String(fields.value) } }
  })
  const view = renderOptions(ATTACHED, mutate)
  await waitFor(() =>
    expect(descriptor(view.result.current.optionSnapshot, 'model')?.defaultChoice).toEqual({
      selected: false
    })
  )
  await act(() => view.result.current.optionSurface.setOption('model', 'gpt-5.6-luna'))
  expect(seededByNextLaunch(mocks.enqueue.mock.calls)).toEqual({ model: 'gpt-5.6-luna' })

  await act(async () => {
    await view.result.current.optionSurface.resetOption?.('model')
  })
  await waitFor(() =>
    expect(descriptor(view.result.current.optionSnapshot, 'model')?.defaultChoice).toEqual({
      selected: true
    })
  )
  expect(view.result.current.capture().selection).not.toHaveProperty('model')
  await act(() => view.result.current.optionSurface.setOption('effort', 'high'))
  expect(seededByNextLaunch(mocks.enqueue.mock.calls)).toBeUndefined()
  view.unmount()
})
