// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { OrcadCaptureRecoverySection } from './OrcadCaptureRecoverySection'

vi.mock('../ui/select', () => ({
  Select: ({
    children,
    onValueChange,
    value,
    disabled
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
    value: string
    disabled?: boolean
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => <option value="">Choose</option>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  )
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
const list = vi.fn()
const recover = vi.fn()
const environment = {
  id: 'destination',
  name: 'Build host',
  runtimeId: 'runtime'
} as PublicKnownRuntimeEnvironment
const candidate = {
  bridgeId: 'bridge',
  terminalId: 'terminal',
  incarnationId: 'incarnation',
  destinationEnvironmentId: 'destination',
  destinationRuntimeId: 'runtime',
  sourceSshTargetId: 'source',
  sourceSshTargetGeneration: 1
}
beforeEach(() => {
  list.mockReset().mockResolvedValue([candidate])
  recover.mockReset().mockResolvedValue({ bridgeId: 'bridge', outcome: 'published' })
  window.api = {
    runtimeEnvironments: { listOrcadOutgoingCaptures: list, recoverOrcadOutgoingCapture: recover }
  } as never
})
afterEach(cleanup)
async function load() {
  render(<OrcadCaptureRecoverySection environments={[environment]} />)
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'destination' } })
  fireEvent.click(screen.getByText('Load saved transfers'))
  await screen.findByText('Retry selected transfer')
}
it('requires explicit selection and reports only confirmed publication', async () => {
  await load()
  const retry = screen.getByText('Retry selected transfer') as HTMLButtonElement
  expect(retry.disabled).toBe(true)
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  fireEvent.click(retry)
  await screen.findByText(
    'Destination publication confirmed. Host cutover and source retirement are separate steps.'
  )
  expect(recover).toHaveBeenCalledExactlyOnceWith({ selector: 'destination', bridgeId: 'bridge' })
})
it('blocks recovery for a changed destination runtime', async () => {
  list.mockResolvedValue([{ ...candidate, destinationRuntimeId: 'old-runtime' }])
  await load()
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  expect((screen.getByText('Retry selected transfer') as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('no longer matches')
  expect(recover).not.toHaveBeenCalled()
})
it('retains the candidate on failure and permits an exact retry', async () => {
  recover.mockRejectedValueOnce(new Error('request timed out'))
  await load()
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  fireEvent.click(screen.getByText('Retry selected transfer'))
  expect((await screen.findByRole('alert')).textContent).toContain('request timed out')
  fireEvent.click(screen.getByText('Retry selected transfer'))
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(2))
  expect(recover.mock.calls[0]).toEqual(recover.mock.calls[1])
})
it('does not turn a failed list read into an empty-state claim', async () => {
  list.mockRejectedValue(new Error('corrupt saved evidence'))
  render(<OrcadCaptureRecoverySection environments={[environment]} />)
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'destination' } })
  fireEvent.click(screen.getByText('Load saved transfers'))
  expect((await screen.findByRole('alert')).textContent).toContain('corrupt saved evidence')
  expect(screen.queryByText('No saved terminal transfers for this server.')).toBeNull()
})
it('locks selection and duplicate retries while a request is pending', async () => {
  let resolveRecovery!: (value: { bridgeId: string; outcome: 'published' }) => void
  recover.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRecovery = resolve
      })
  )
  await load()
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  const retry = screen.getByText('Retry selected transfer')
  fireEvent.click(retry)
  fireEvent.click(retry)
  expect(recover).toHaveBeenCalledTimes(1)
  for (const select of screen.getAllByRole('combobox')) {
    expect((select as HTMLSelectElement).disabled).toBe(true)
  }
  expect((screen.getByText('Load saved transfers') as HTMLButtonElement).disabled).toBe(true)
  resolveRecovery({ bridgeId: 'bridge', outcome: 'published' })
  await screen.findByText(
    'Destination publication confirmed. Host cutover and source retirement are separate steps.'
  )
})
it('clears saved selection when the destination changes', async () => {
  render(
    <OrcadCaptureRecoverySection
      environments={[environment, { ...environment, id: 'second', name: 'Second host' }]}
    />
  )
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'destination' } })
  fireEvent.click(screen.getByText('Load saved transfers'))
  await screen.findByText('Retry selected transfer')
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'second' } })
  expect(screen.queryByText('Retry selected transfer')).toBeNull()
  expect(recover).not.toHaveBeenCalled()
})
it('explicitly loads preparations and explains source capture before retry', async () => {
  list.mockResolvedValue([{ ...candidate, stage: 'preparation' }])
  await load()
  expect(list).toHaveBeenCalledExactlyOnceWith({
    selector: 'destination',
    includePreparations: true
  })
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'bridge' } })
  expect(screen.getByText(/Saved preparation: retry continues source preparation/)).toBeTruthy()
  fireEvent.click(screen.getByText('Retry selected transfer'))
  await waitFor(() =>
    expect(recover).toHaveBeenCalledExactlyOnceWith({
      selector: 'destination',
      bridgeId: 'bridge',
      stage: 'preparation'
    })
  )
})
