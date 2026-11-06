// @vitest-environment happy-dom
import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  requestDirectWorkItemSetup,
  type DirectWorkItemSetupRequest
} from '@/lib/direct-work-item-setup'
import { DirectWorkItemSetupDialog } from './DirectWorkItemSetupDialog'
import type { DirectSetupInspection } from '@/lib/launch-work-item-direct-preflight'

const initial = useAppStore.getState()
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  useAppStore.getState().closeModal()
  useAppStore.setState(initial, true)
})
function request(): DirectWorkItemSetupRequest {
  return readDirectSetupRequest(useAppStore.getState().modalData.directSetup)
}

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
