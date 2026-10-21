// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/machines/machine-creation-cancel', () => ({ cancelMachineCreation: mocks.cancel }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        machineProviders: { 'plugin:o/omarchy': { name: 'Omarchy' } },
        projects: [{ id: 'p', displayName: 'acme/web' }]
      }),
    { getState: () => ({ updatePendingWorktreeCreation: mocks.update }) }
  )
}))

import MachineCreationStatus from './MachineCreationStatus'

function entry(overrides: Partial<PendingWorktreeCreation>): PendingWorktreeCreation {
  return {
    creationId: 'c-1',
    phase: 'starting-machine',
    status: 'creating',
    startedAt: 0,
    indeterminate: true,
    loaderVisible: true,
    machineProgress: { activity: 'creating' },
    request: {
      repoId: 'r',
      name: 'fix-auth',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null,
      machine: {
        sourceRepoId: 'r',
        projectId: 'p',
        providerKey: 'plugin:o/omarchy',
        machineName: 'box',
        create: { operationId: 'op', name: 'box', lifetime: 'temporary' }
      }
    },
    ...overrides
  }
}

afterEach(cleanup)

describe('MachineCreationStatus', () => {
  it('offers Cancel only while the machine is starting', () => {
    render(<MachineCreationStatus entry={entry({})} onRetry={vi.fn()} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.cancel).toHaveBeenCalledWith('c-1')
    cleanup()
    render(
      <MachineCreationStatus
        entry={entry({ phase: 'setting-up-project' })}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('names the new machine, its provider and lifetime and marks the stages for tests', () => {
    const { container } = render(
      <MachineCreationStatus entry={entry({})} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getByText('New machine box on Omarchy · Temporary')).toBeTruthy()
    const stage = container.querySelector('[data-machine-stages] [data-stage="starting-machine"]')
    expect(stage?.getAttribute('data-state')).toBe('active')
  })

  it('shows the plain error under the failed stage with Retry and Remove worktree', () => {
    const onRetry = vi.fn()
    render(
      <MachineCreationStatus
        entry={entry({
          phase: 'fetching',
          status: 'error',
          error: 'Couldn’t set up the project on the machine.'
        })}
        onRetry={onRetry}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('Couldn’t set up fix-auth')).toBeTruthy()
    expect(screen.getByText('Couldn’t set up the project on the machine.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeTruthy()
  })

  it('after a cancel, checks for a leftover machine rather than claiming one exists', () => {
    render(
      <MachineCreationStatus
        entry={entry({
          status: 'error',
          machineProgress: { activity: 'creating', canceled: true }
        })}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Check for a leftover machine' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('after a cancel once the machine exists, says so and offers Delete', async () => {
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          machines: {
            delete: vi.fn().mockResolvedValue({ ok: true, value: { id: 'm-1', state: 'gone' } })
          }
        }
      })
    )
    const created = entry({
      status: 'error',
      machineProgress: { activity: 'connecting', canceled: true }
    })
    const machine = created.request.machine
    render(
      <MachineCreationStatus
        entry={{
          ...created,
          request: { ...created.request, machine: machine && { ...machine, machineId: 'm-1' } }
        }}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(
      screen.getByText('box was already created on Omarchy and is still running.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete box' }))
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('c-1', {
        machineProgress: expect.objectContaining({ leftoverDeleted: true })
      })
    )
    cleanup()
    render(
      <MachineCreationStatus
        entry={entry({
          status: 'error',
          machineProgress: { activity: 'connecting', canceled: true, leftoverDeleted: true }
        })}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('The machine this create left behind was deleted.')).toBeTruthy()
  })
})
