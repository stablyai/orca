// @vitest-environment happy-dom
import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  requestDirectWorkItemSetup,
  type DirectWorkItemSetupRequest
} from '@/lib/direct-work-item-setup'
import { DirectWorkItemSetupDialog } from './DirectWorkItemSetupDialog'
import type { DirectSetupInspection } from '@/lib/launch-work-item-direct-preflight'

const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.getState().closeModal()
  useAppStore.setState(initial, true)
})
function request(): DirectWorkItemSetupRequest {
  return readDirectSetupRequest(useAppStore.getState().modalData.directSetup)
}
const recovered: DirectSetupInspection = {
  kind: 'needs-modal',
  setupConfig: {
    source: 'yaml',
    command: 'echo prepared',
    kind: 'setup'
  }
}

it('disables setup choices until a failed inspection recovers, then accepts one concrete answer', async () => {
  const retry = Promise.withResolvers<DirectSetupInspection>()
  const result = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, () => retry.promise)
  render(<DirectWorkItemSetupDialog request={request()} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run setup' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(true)
  await act(async () => retry.resolve(recovered))
  expect(screen.getByText('echo prepared')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run setup' }))
  await expect(result).resolves.toBe('run')
})

it('ignores recovery after cancellation without closing the replacement modal', async () => {
  const retry = Promise.withResolvers<DirectSetupInspection>()
  const result = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, () => retry.promise)
  const old = request()
  render(<DirectWorkItemSetupDialog request={old} />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  useAppStore.getState().openModal('quick-open', { section: 'appearance' })
  await expect(result).resolves.toBe('cancelled')
  await act(async () => retry.resolve({ kind: 'decided', decision: 'run' }))
  expect(old.isPending()).toBe(false)
  expect(useAppStore.getState().modalData).toEqual({ section: 'appearance' })
})
