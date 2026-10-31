// @vitest-environment happy-dom
import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type en from '@/i18n/locales/en.json'
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

const catalogs = import.meta.glob<typeof en>('../../i18n/locales/*.json', {
  eager: true,
  import: 'default'
})
it.each(Object.entries(catalogs))(
  'preserves builtin dialog output and recovered choices for %s',
  async (file, catalog) => {
    const locale = file.split('/').at(-1)!.replace('.json', '')
    await i18n.changeLanguage(locale)
    const retry = Promise.withResolvers<DirectSetupInspection>()
    const result = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, () => retry.promise)
    render(<DirectWorkItemSetupDialog request={request()} />)
    expect(screen.getByRole('heading').textContent).toBe('Run setup · Repo')
    expect(
      screen.getByText(catalog.auto.components.NewWorkspaceComposerCard['9a70e4859e'])
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: catalog.common.cancel })).toBeTruthy()
    expect(screen.getByText('Could not check setup configuration. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: catalog.common.retry }))
    await act(async () => retry.resolve(recovered))
    expect(screen.getByText('echo prepared')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run setup' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    await expect(result).resolves.toBe('skip')
  }
)
