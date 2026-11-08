import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom
import {
  answer,
  mutateWith,
  renderOptions,
  REOPENED,
  currentValue
} from './use-structured-agent-session-options.test-fixture'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'

import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))

it('projects transmitted mode admission to the optimistic exit control and recovers after settlement', async () => {
  const sessionId = 'mode-admission-projection'
  forgetStructuredSessionSelection(sessionId)
  let interactionMode: 'default' | 'plan' = 'default'
  const reply = Promise.withResolvers<{
    key: string
    value: string
    options: Record<string, string>
  }>()
  answer({
    options: async () => ({
      models: [],
      current: { interactionMode, acceptedInputSources: { interactionMode: 'saved' } }
    })
  })
  const { mutate } = mutateWith(async (_method, _fingerprint, fields) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the option writer sends the fixture its key/value fields.
    const pick = fields as { key: string; value: string }
    return pick.key === 'interactionMode' ? reply.promise : { key: pick.key, value: pick.value }
  })
  const hook = renderOptions({ ...REOPENED, sessionId }, mutate)
  try {
    await waitFor(() =>
      expect(hook.result.current.optionSurface.admits?.('interactionMode', 'plan')).toBe(true)
    )
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = hook.result.current.setStructuredOption('interactionMode', 'plan')
    })
    await waitFor(() =>
      expect(currentValue(hook.result.current.optionSnapshot, 'interactionMode')).toBe('plan')
    )
    expect(
      hook.result.current.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable
    ).toBe(false)
    await act(async () => {
      await hook.result.current.setStructuredOption('effort', 'high')
    })
    expect(
      hook.result.current.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable
    ).toBe(false)
    interactionMode = 'plan'
    await act(async () => {
      reply.resolve({ key: 'interactionMode', value: 'plan', options: { interactionMode: 'plan' } })
      await pending
    })
    await waitFor(() =>
      expect(
        hook.result.current.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable
      ).toBe(true)
    )
  } finally {
    hook.unmount()
    forgetStructuredSessionSelection(sessionId)
  }
})
