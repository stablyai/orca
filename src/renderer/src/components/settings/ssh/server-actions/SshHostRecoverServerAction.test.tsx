// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadManagedStaleLockReclaimResult } from '../../../../../../shared/orcad-managed-runtime'
import type { SshManagedServerStatus } from '../../../../../../shared/ssh-types'
import { SshHostRecoverServerDialog } from './SshHostRecoverServerAction'

vi.mock('../../../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const COMMAND = '/opt/bun /slot/orcad.js --reclaim-stale-lock --data-root /home/dev/.orca'
const DETAIL = `orcad holds the data root. If it is not running anywhere, run \`${COMMAND}\` on the machine it ran on.`
const refusedStart: SshManagedServerStatus = {
  kind: 'managed',
  environmentId: 'env-1',
  serving: { state: 'unverifiable', detail: DETAIL }
}

const eligible: OrcadManagedStaleLockReclaimResult = {
  status: 'eligible',
  lockPath: '/home/dev/.orca/orcad.lock',
  message: 'eligible',
  evidence: {
    pid: 41,
    host: 'box',
    bootId: 'boot-old',
    currentBootId: 'boot-new',
    ageMinutes: 90,
    nonce: 'n-approved'
  }
}
const reclaimStaleLock = vi.fn(
  async (args: { yes: boolean }): Promise<OrcadManagedStaleLockReclaimResult> =>
    args.yes
      ? { status: 'reclaimed', environmentId: 'env-1', message: 'cleared', lockPath: '/l' }
      : eligible
)
const roots: Root[] = []
beforeEach(() => {
  reclaimStaleLock.mockClear()
  Object.assign(window, { api: { runtimeEnvironments: { managedOrcad: { reclaimStaleLock } } } })
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

async function render(onOpenChange = vi.fn(), onChanged = vi.fn()) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const show = (status: SshManagedServerStatus) =>
    act(async () => {
      root.render(
        <SshHostRecoverServerDialog
          status={status}
          open
          onOpenChange={onOpenChange}
          onChanged={onChanged}
        />
      )
    })
  await show(refusedStart)
  return Object.assign(container, { show })
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!
}

describe('Recover server', () => {
  it('clears the lock only after the user rules out another machine', async () => {
    const onOpenChange = vi.fn()
    const onChanged = vi.fn()
    const container = await render(onOpenChange, onChanged)
    expect(reclaimStaleLock).toHaveBeenCalledWith({ selector: 'env-1', yes: false })
    expect(container.textContent).toContain('boot-old')
    const confirm = button(container, 'Clear lock and restart')
    expect(confirm.disabled).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    expect(confirm.disabled).toBe(false)
    expect(reclaimStaleLock).toHaveBeenCalledTimes(1)
    await act(async () => confirm.click())
    expect(reclaimStaleLock).toHaveBeenLastCalledWith({
      selector: 'env-1',
      yes: true,
      expectNonce: 'n-approved'
    })
    expect(onChanged).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // The reclaim clears the note that offered it, so the status no longer passes the gate.
  it('stays open with its result once the status that offered it is gone', async () => {
    reclaimStaleLock.mockResolvedValueOnce(eligible).mockResolvedValueOnce({
      status: 'reclaimed',
      environmentId: 'env-1',
      message: 'cleared',
      lockPath: '/l',
      notRestarted: 'did not start'
    })
    const onOpenChange = vi.fn()
    const container = await render(onOpenChange)
    await container.show({ kind: 'managed', environmentId: 'env-1' })
    expect(container.textContent).toContain('boot-old')
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    await act(async () => button(container, 'Clear lock and restart').click())
    expect(container.textContent).toContain('did not start')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('boot-old')
    expect(button(container, 'Clear lock and restart')).toBeUndefined()
    expect(container.textContent).not.toContain('--reclaim-stale-lock')
    expect(container.textContent).not.toContain('rm /')
    expect(button(container, 'Close')).toBeDefined()
  })
})
