// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { OrcadLiveMigrationProgress } from '../../../../shared/orcad-live-migration-recovery'
import { OrcadLiveMigrationSection } from './OrcadLiveMigrationSection'

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
const web = vi.hoisted(() => vi.fn(() => false))
const refresh = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/orcad-migration-renderer-refresh', () => ({
  refreshOrcadMigrationRenderer: refresh
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: web }))

const list = vi.fn<() => Promise<OrcadLiveMigrationProgress[]>>()
const targets = vi.fn()
const start = vi.fn<() => Promise<void>>()
const resume = vi.fn<() => Promise<void>>()
const connect = vi.fn<() => Promise<boolean>>()
const environment = {
  id: 'destination',
  name: 'Build host',
  runtimeId: 'runtime'
} as PublicKnownRuntimeEnvironment
const saved: OrcadLiveMigrationProgress = {
  migrationId: 'migration',
  destinationEnvironmentId: 'destination',
  sourceSshTargetId: 'source',
  phase: 'destination-committed',
  phaseEvidence: 'journal-retained',
  profileState: 'prepared',
  receipts: { recorded: 0, total: 2 },
  sourceRetirement: 'pending'
}

beforeEach(() => {
  vi.resetAllMocks()
  refresh.mockImplementation((environment, _migrationId, connect) => connect(environment))
  web.mockReturnValue(false)
  list.mockResolvedValue([])
  targets.mockResolvedValue([{ id: 'source', label: 'Source host' }])
  start.mockResolvedValue(undefined)
  resume.mockResolvedValue(undefined)
  connect.mockResolvedValue(true)
  window.api = {
    runtimeEnvironments: {
      listOrcadLiveMigrations: list,
      startOrcadLiveMigration: start,
      resumeOrcadLiveMigration: resume
    },
    ssh: { listTargets: targets }
  } as never
})
afterEach(cleanup)

function mount() {
  return render(
    <OrcadLiveMigrationSection environments={[environment]} onConnectDestination={connect} />
  )
}
function selectDestination() {
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'destination' } })
}
async function load(entries: OrcadLiveMigrationProgress[] = []) {
  list.mockResolvedValue(entries)
  mount()
  selectDestination()
  fireEvent.click(screen.getByText('Load migration status'))
  await screen.findByText('Start host migration')
}
function selectSource() {
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'source' } })
}
const button = (text: string) => screen.getByRole('button', { name: text }) as HTMLButtonElement

it('invalidates loaded status when a destination is re-paired without changing its runtime ID', async () => {
  const view = mount()
  selectDestination()
  fireEvent.click(button('Load migration status'))
  await screen.findByText('Start host migration')
  selectSource()
  view.rerender(
    <OrcadLiveMigrationSection
      environments={[{ ...environment, pairingRevision: 2 }]}
      onConnectDestination={connect}
    />
  )
  expect(screen.queryByText('Start host migration')).toBeNull()
  expect(list).toHaveBeenCalledTimes(1)
  expect(start).not.toHaveBeenCalled()
})

it('keeps the operation lock when destination rebinding remounts the form', async () => {
  let finish!: () => void
  start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const view = mount()
  selectDestination()
  fireEvent.click(button('Load migration status'))
  await screen.findByText('Start host migration')
  selectSource()
  fireEvent.click(button('Start host migration'))
  view.rerender(
    <OrcadLiveMigrationSection
      environments={[{ ...environment, pairingRevision: 2 }]}
      onConnectDestination={connect}
    />
  )
  expect(button('Load migration status').disabled).toBe(true)
  await act(async () => {
    finish()
  })
  await waitFor(() => expect(button('Load migration status').disabled).toBe(false))
  expect(screen.queryByText('Start host migration')).toBeNull()
  expect(start).toHaveBeenCalledTimes(1)
})

it('does not load or mutate on mount or destination selection alone', () => {
  mount()
  expect(screen.queryByText('Load migration status')).toBeNull()
  selectDestination()
  expect(list).not.toHaveBeenCalled()
  expect(targets).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})

it('explains a disabled main-process gate without automatically retrying the mutation', async () => {
  start.mockRejectedValue(new Error('pty_ownership_transfer_mutation_disabled'))
  await load()
  selectSource()
  fireEvent.click(button('Start host migration'))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Experimental host migration is disabled in this app.'
  )
  expect(start).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenCalledTimes(2)
})

it('requires explicit destination, status load and source selection, sending identifiers only', async () => {
  await load()
  expect(list).toHaveBeenCalledExactlyOnceWith({ selector: 'destination' })
  expect(button('Start host migration').disabled).toBe(true)
  selectSource()
  fireEvent.click(button('Start host migration'))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(start).toHaveBeenCalledExactlyOnceWith({ selector: 'destination', targetId: 'source' })
  expect(resume).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})

it('blocks duplicate start clicks and destination changes while pending', async () => {
  const pending = Promise.withResolvers<void>()
  start.mockReturnValue(pending.promise)
  await load()
  selectSource()
  const begin = button('Start host migration')
  act(() => {
    fireEvent.click(begin)
    fireEvent.click(begin)
  })
  expect(start).toHaveBeenCalledOnce()
  expect(button('Load migration status').disabled).toBe(true)
  expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).disabled).toBe(true)
  await act(async () => pending.resolve())
  await screen.findByText('Start host migration')
  expect(start).toHaveBeenCalledOnce()
})

it('reloads saved intent after a rejected start without automatically retrying mutation', async () => {
  await load()
  list.mockResolvedValue([{ ...saved, phase: 'source-fenced', phaseEvidence: 'intent-only' }])
  start.mockRejectedValueOnce(new Error('publication reply lost'))
  selectSource()
  fireEvent.click(button('Start host migration'))
  expect((await screen.findByRole('alert')).textContent).toContain('publication reply lost')
  expect(screen.getByText(/Saved intent only/)).toBeTruthy()
  expect(list).toHaveBeenCalledTimes(2)
  expect(start).toHaveBeenCalledOnce()
  expect(resume).not.toHaveBeenCalled()
  fireEvent.click(button('Continue with connected original source'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[0]).toEqual(start.mock.calls[1])
  expect(resume).not.toHaveBeenCalled()
})

it('does not turn a failed status load into an empty-state claim', async () => {
  mount()
  selectDestination()
  list.mockRejectedValueOnce(new Error('saved evidence unreadable'))
  fireEvent.click(button('Load migration status'))
  expect((await screen.findByRole('alert')).textContent).toContain('saved evidence unreadable')
  expect(screen.queryByText('No saved host migrations for this server.')).toBeNull()
  expect(screen.queryByText('Start host migration')).toBeNull()
  expect(start).not.toHaveBeenCalled()
})

it.each(['phase-unverifiable', undefined] as const)(
  'blocks absent or %s phase evidence',
  async (phaseEvidence) => {
    await load([{ ...saved, phaseEvidence, sourceRetirement: 'complete' }])
    expect(button('Continue with connected original source').disabled).toBe(true)
    expect(screen.queryByText('Recover retirement from saved evidence')).toBeNull()
    expect(screen.queryByText('Refresh destination catalog')).toBeNull()
    fireEvent.click(button('Continue with connected original source'))
    expect(start).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  }
)

it('blocks both continuation modes and completion claims for profile conflicts', async () => {
  await load([{ ...saved, profileState: 'conflict', sourceRetirement: 'complete' }])
  expect(button('Continue with connected original source').disabled).toBe(true)
  expect(button('Recover retirement from saved evidence').disabled).toBe(true)
  expect(screen.queryByText('Host cutover and source retirement confirmed.')).toBeNull()
  expect(screen.queryByText('Refresh destination catalog')).toBeNull()
})

it.each([
  ['Continue with connected original source', 'initial'],
  ['Recover retirement from saved evidence', 'recovery']
] as const)('sends the exact %s resume selection', async (label, mode) => {
  await load([saved])
  fireEvent.click(button(label))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(resume).toHaveBeenCalledExactlyOnceWith({
    selector: 'destination',
    migrationId: 'migration',
    mode
  })
  expect(start).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})

it('does not infer retirement completion from phase or receipt counts alone', async () => {
  await load([{ ...saved, phase: 'source-routes-removed', receipts: { recorded: 2, total: 2 } }])
  expect(screen.queryByText('Host cutover and source retirement confirmed.')).toBeNull()
  expect(screen.queryByText('Refresh destination catalog')).toBeNull()
  expect(button('Recover retirement from saved evidence').disabled).toBe(false)
})

it('does not accept an intent-only completion claim as durable journal evidence', async () => {
  await load([{ ...saved, phaseEvidence: 'intent-only', sourceRetirement: 'complete' }])
  expect(screen.queryByText('Host cutover and source retirement confirmed.')).toBeNull()
  expect(screen.queryByText('Refresh destination catalog')).toBeNull()
  fireEvent.click(button('Continue with connected original source'))
  await waitFor(() =>
    expect(start).toHaveBeenCalledExactlyOnceWith({ selector: 'destination', targetId: 'source' })
  )
  expect(resume).not.toHaveBeenCalled()
})

it('clears actionable saved state when the post-mutation evidence reload fails', async () => {
  await load([saved])
  list.mockRejectedValueOnce(new Error('journal reload unavailable'))
  fireEvent.click(button('Recover retirement from saved evidence'))
  expect((await screen.findByRole('alert')).textContent).toContain('journal reload unavailable')
  expect(screen.queryByText('Recover retirement from saved evidence')).toBeNull()
  expect(screen.queryByText('Start host migration')).toBeNull()
  expect(screen.queryByText('No saved host migrations for this server.')).toBeNull()
  expect(resume).toHaveBeenCalledOnce()
})

it('only refreshes a durably completed destination on explicit click and honors callback failure', async () => {
  await load([{ ...saved, sourceRetirement: 'complete', receipts: { recorded: 2, total: 2 } }])
  expect(screen.getByText('Host cutover and source retirement confirmed.')).toBeTruthy()
  expect(screen.queryByText('Continue with connected original source')).toBeNull()
  expect(connect).not.toHaveBeenCalled()
  connect.mockResolvedValueOnce(false)
  fireEvent.click(button('Refresh destination catalog'))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not refresh the destination catalog'
  )
  expect(connect).toHaveBeenCalledExactlyOnceWith(environment)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(environment, saved.migrationId, connect)
  expect(screen.queryByText(/Destination catalog refreshed/)).toBeNull()
  fireEvent.click(button('Refresh destination catalog'))
  await screen.findByText(/Destination catalog refreshed/)
  expect(connect).toHaveBeenCalledTimes(2)
  expect(list).toHaveBeenCalledOnce()
  expect(start).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

it('does not report refresh complete while migration-specific reconciliation is pending', async () => {
  await load([{ ...saved, sourceRetirement: 'complete', receipts: { recorded: 2, total: 2 } }])
  let complete!: (value: boolean) => void
  refresh.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      complete = resolve
    })
  )
  fireEvent.click(button('Refresh destination catalog'))
  expect(button('Refresh destination catalog').disabled).toBe(true)
  expect(screen.queryByText(/Destination catalog refreshed/)).toBeNull()
  await act(async () => complete(true))
  await screen.findByText(/Destination catalog refreshed/)
})

it('does not expose migration controls or call APIs in the web client', () => {
  web.mockReturnValue(true)
  const view = mount()
  expect(view.container.innerHTML).toBe('')
  expect(list).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})
