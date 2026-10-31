// @vitest-environment happy-dom

import { within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, makeRun } from './automations-page-fixtures'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

installAutomationsPageHarness()

it('reads bootstrap attachments from the run history host after navigation settles', async () => {
  const automation = makeAutomation()
  const run = makeRun({
    outputs: [{ id: 'o1', title: 'Notes', format: 'markdown', bytes: 5, attachedAt: 1 }]
  })
  runtimeHost([automation], [run])
  mocks.state.selectedAutomationId = automation.id
  mocks.state.setPendingAutomationRunNavigation = mocks.setPendingRunNavigation
  mocks.state.pendingAutomationRunNavigation = {
    automationId: automation.id,
    runId: run.id,
    hostId: 'runtime:gpu'
  }
  mocks.setPendingRunNavigation.mockImplementation((navigation) => {
    mocks.state.pendingAutomationRunNavigation = navigation
  })
  const original = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(
    (target: unknown, method: string, params?: unknown, ...rest: unknown[]) => {
      if (method === 'automation.list') {
        return params && typeof params === 'object' && 'selector' in params
          ? new Promise(() => {})
          : Promise.resolve({ automations: [automation] })
      }
      if (method === 'automation.readOutput') {
        const remote =
          typeof target === 'object' &&
          target !== null &&
          'environmentId' in target &&
          target.environmentId === 'gpu'
        return Promise.resolve({
          content: remote ? 'Remote attachment content' : 'Wrong local attachment'
        })
      }
      return original?.(target, method, params, ...rest)
    }
  )

  const { container, rerender } = await renderPage()
  await settleHostQueries()
  await rerender()
  expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
  expect(await within(container).findByText('Remote attachment content')).toBeTruthy()
  expect(within(container).queryByText('Wrong local attachment')).toBeNull()
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'gpu' },
    'automation.readOutput',
    { runId: run.id, outputId: 'o1' },
    { timeoutMs: 15_000 }
  )
})
