// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcadManagedRuntimeStatus } from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { ManagedServerRow } from './ManagedServerRow'

vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

const status: OrcadManagedRuntimeStatus = {
  environmentId: 'env-1',
  sshTargetId: 'ssh-1',
  activeVersion: '1.2.0',
  previousVersion: '1.1.0',
  activatedAt: '2026-10-01T00:00:00.000Z',
  rollbackAvailable: false,
  recovery: null,
  terminals: { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null },
  migration: { migrationId: 'm-1', phase: 'destination-staged', startedAt: 'now' },
  deferredUpdate: {
    outcome: 'deferred',
    candidateVersion: '1.3.0',
    code: 'orcad_update_terminal_census_unavailable',
    reason: 'the daemon did not answer',
    deferredAt: 'now'
  }
}

async function render(
  rowStatus: OrcadManagedRuntimeStatus = status,
  getStatus: () => Promise<OrcadManagedRuntimeStatus> = async () => rowStatus
) {
  const stop = vi.fn(async () => ({ outcome: 'unlinked' }))
  const forget = vi.fn(async () => ({ outcome: 'forgotten' }))
  const recover = vi.fn(async (args: { acceptChangedState?: boolean }) =>
    args.acceptChangedState
      ? { outcome: 'none' }
      : { outcome: 'refused', verdict: 'unverifiable', code: 'orcad_recovery_changed_state' }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row calls only getStatus, stop, forget and recover here.
  const api = {
    getStatus: vi.fn(getStatus),
    stop,
    forget,
    recover
  } as unknown as ManagedOrcadPreloadApi
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only id and name.
  const environment = { id: 'env-1', name: 'Builder' } as PublicKnownRuntimeEnvironment
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<ManagedServerRow api={api} environment={environment} onChanged={() => {}} />)
  })
  return { container, stop, forget, recover }
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent === label)

describe('managed server row', () => {
  it('reports unknown terminals, the running migration and the deferred update', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('Running terminals: unknown')
    expect(container.textContent).toContain('Migration: Copy staged')
    expect(container.textContent).toContain('Update to 1.3.0 deferred.')
    expect(container.textContent).toContain('couldn’t confirm what is running')
    expect(container.textContent).not.toContain('the daemon did not answer')
    expect(button(container, 'Roll back')).toBeUndefined()
  })

  it('stops only after a second, explicit confirmation', async () => {
    const { container, stop } = await render()
    await act(async () => button(container, 'Stop…')?.click())
    expect(stop).not.toHaveBeenCalled()
    await act(async () => button(container, 'Stop and remove server')?.click())
    expect(stop).toHaveBeenCalledWith({ selector: 'env-1' })
  })

  it('offers Forget only for a host that did not answer, behind a confirmation (P1-E)', async () => {
    const reachable = await render()
    expect(button(reachable.container, 'Forget…')).toBeUndefined()

    const gone = await render(status, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:2841')
    })
    await act(async () => button(gone.container, 'Forget…')?.click())
    expect(gone.forget).not.toHaveBeenCalled()
    expect(gone.container.textContent).toContain('without contacting its host')
    await act(async () => button(gone.container, 'Forget on this desktop')?.click())
    expect(gone.forget).toHaveBeenCalledWith({ selector: 'env-1' })
  })

  it('restores a snapshot over changed state only after the operator accepts it', async () => {
    const recovery = {
      operation: 'activate' as const,
      phase: 'snapshot-captured' as const,
      version: '1.3.0',
      startedAt: 'now'
    }
    const { container, recover } = await render({ ...status, recovery })
    await act(async () => button(container, 'Recover')?.click())
    expect(recover).toHaveBeenLastCalledWith({ selector: 'env-1', acceptChangedState: false })
    await act(async () => button(container, 'Restore snapshot and restart')?.click())
    expect(recover).toHaveBeenLastCalledWith({ selector: 'env-1', acceptChangedState: true })
  })

  it('never calls a status it could not read "Not running"', async () => {
    const pending = await render(status, () => new Promise(() => {}))
    expect(pending.container.textContent).toContain('Checking…')
    expect(pending.container.textContent).not.toContain('Not running')

    const unreachable = await render(status, async () => {
      throw new Error('host unreachable')
    })
    expect(unreachable.container.textContent).toContain('Status unknown')
    expect(unreachable.container.textContent).not.toContain('Not running')

    const stopped = await render({ ...status, activeVersion: null })
    expect(stopped.container.textContent).toContain('Not running')
  })
})
