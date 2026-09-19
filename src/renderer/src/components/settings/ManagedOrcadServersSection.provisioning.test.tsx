// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ManagedOrcadServersSection } from './ManagedOrcadServersSection'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./ManagedOrcadServerDialogs', () => ({ ManagedOrcadServerDialogs: () => null }))
vi.mock('./ManagedOrcadServerRow', () => ({
  ManagedOrcadServerRow: ({ environment }: { environment: { name: string } }) => (
    <div>{environment.name}</div>
  )
}))

const pending = { requestId: 'request-1', name: 'Interrupted host', sshTargetId: 'ssh-pending' }
const migration = {
  environmentId: 'environment-pending',
  name: 'Interrupted host',
  sshTargetId: 'ssh-pending',
  sshTargetLabel: 'Pending SSH host',
  phase: 'source-fenced',
  startedAt: new Date(1).toISOString()
}
const list = vi.fn()
const listPending = vi.fn()
const listMigrations = vi.fn()
const resume = vi.fn()
const deploy = vi.fn()
const changed = vi.fn()

function mount() {
  return render(
    <ManagedOrcadServersSection activeEnvironmentId={null} onEnvironmentsChanged={changed} />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  list.mockReset().mockResolvedValue([])
  listPending.mockReset().mockResolvedValue([pending])
  listMigrations.mockReset().mockResolvedValue([])
  resume.mockReset()
  Object.assign(window, {
    api: {
      runtimeEnvironments: {
        list,
        listPendingOrcadSshProvisioning: listPending,
        listPendingOrcadMigrations: listMigrations,
        resumeOrcadSshHost: resume,
        deployOrcad: deploy,
        getOrcadStatus: vi.fn().mockResolvedValue({})
      },
      ssh: { listTargets: vi.fn().mockResolvedValue([]) }
    }
  })
})
afterEach(cleanup)

describe('managed SSH provisioning recovery rows', () => {
  it('discovers pre-journal setup after reopening without automatically retrying', async () => {
    const first = mount()
    expect(await screen.findByText('Interrupted host')).toBeTruthy()
    expect(screen.getByText(/SSH host remains reserved/)).toBeTruthy()
    expect(screen.queryByText('No managed Orca servers.')).toBeNull()
    first.unmount()
    mount()
    expect(await screen.findByText('Interrupted host')).toBeTruthy()
    expect(listPending).toHaveBeenCalledTimes(2)
    expect(resume).not.toHaveBeenCalled()
    expect(deploy).not.toHaveBeenCalled()
  })

  it('renders one row when the same host has both intent and a migration journal', async () => {
    listMigrations.mockResolvedValue([migration])
    resume.mockResolvedValue({
      ...pending,
      repoReadoptions: [],
      result: { outcome: 'pending', reason: 'Host is unverifiable.' }
    })
    mount()
    await screen.findByText('Interrupted host')
    expect(screen.getAllByText('Interrupted host')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Resume setup' }))
    await screen.findByText('Host is unverifiable.')
    expect(resume).toHaveBeenCalledWith({ requestId: 'request-1' })
    expect(deploy).not.toHaveBeenCalled()
  })

  it('preserves a separate legacy migration row and its existing retry path', async () => {
    listMigrations.mockResolvedValue([
      { ...migration, name: 'Legacy host', sshTargetId: 'ssh-legacy' }
    ])
    deploy.mockResolvedValue({
      outcome: 'deferred',
      reason: 'Legacy migration blocked.',
      forceable: false
    })
    mount()
    await screen.findByText('Legacy host')
    expect(screen.getAllByRole('button', { name: 'Resume setup' })).toHaveLength(2)
    const legacyRow = screen.getByText('Legacy host').closest('.flex.items-start')!
    fireEvent.click(legacyRow.querySelector('button')!)
    await screen.findByText('Legacy migration blocked.')
    expect(deploy).toHaveBeenCalledWith({
      name: 'Legacy host',
      sshTargetId: 'ssh-legacy',
      force: undefined
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it.each(['pending', 'deferred'] as const)(
    'keeps %s results inline without success or force promotion',
    async (outcome) => {
      resume.mockResolvedValue({
        ...pending,
        repoReadoptions: [],
        result: {
          outcome,
          reason: 'Live sessions require recovery.',
          candidateVersion: 'bun-1',
          code: 'blocked',
          forceable: true
        }
      })
      mount()
      fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }))
      expect(await screen.findByText('Live sessions require recovery.')).toBeTruthy()
      expect(screen.getByText('Interrupted host')).toBeTruthy()
      expect(toast.success).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(deploy).not.toHaveBeenCalled()
      expect(resume).toHaveBeenCalledWith({ requestId: 'request-1' })
    }
  )

  it('disables retry while in flight, then surfaces transport failure', async () => {
    let reject!: (error: Error) => void
    resume.mockImplementation(
      () =>
        new Promise((_resolve, rejectRequest) => {
          reject = rejectRequest
        })
    )
    mount()
    const button = await screen.findByRole('button', { name: 'Resume setup' })
    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(resume).toHaveBeenCalledOnce()
    await act(async () => {
      reject(new Error('Connection is unverifiable.'))
    })
    expect(await screen.findByText('Connection is unverifiable.')).toBeTruthy()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('refreshes the environment catalog only after acknowledged activation', async () => {
    const environment = {
      id: 'managed-1',
      name: 'Ready host',
      orcadDeployment: {
        sshTargetId: pending.sshTargetId,
        sshTargetGeneration: 1,
        localPort: 40000,
        remotePort: 6768
      }
    }
    resume.mockImplementation(async () => {
      list.mockResolvedValue([environment])
      listPending.mockResolvedValue([])
      return {
        ...pending,
        repoReadoptions: [],
        result: { outcome: 'created', activeVersion: 'bun-1', environment }
      }
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }))
    expect(await screen.findByText('Ready host')).toBeTruthy()
    expect(screen.queryByText('Interrupted host')).toBeNull()
    expect(toast.success).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('does not duplicate an already registered managed environment', async () => {
    list.mockResolvedValue([
      {
        id: 'registered',
        name: 'Ready host',
        orcadDeployment: { sshTargetId: pending.sshTargetId }
      }
    ])
    listMigrations.mockResolvedValue([migration])
    mount()
    expect(await screen.findByText('Ready host')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume setup' })).toBeNull()
    expect(screen.queryByText('Interrupted host')).toBeNull()
  })

  it('surfaces failed provisioning discovery instead of claiming an empty catalog', async () => {
    listPending.mockRejectedValue(new Error('Provisioning state unavailable.'))
    mount()
    await waitFor(() => expect(screen.getByText('Provisioning state unavailable.')).toBeTruthy())
    expect(screen.queryByText('No managed Orca servers.')).toBeNull()
    expect(resume).not.toHaveBeenCalled()
  })
})
