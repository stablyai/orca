// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus, SshTarget } from '../../../../shared/ssh-types'
import { SshHostMoveAnywayAction } from './SshHostMoveAnywayAction'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const target: SshTarget = { id: 'ssh-1', label: 'Builder', host: 'b', port: 22, username: 'dev' }
const refused: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'refused',
  detail: 'This SSH host cannot move yet: saved tabs and panes (unsaved changes to /etc/hosts).',
  canLeaveBehind: true
}

const allowMoveLeavingBehind = vi.fn(async () => {})
const connect = vi.fn(async () => null)
const roots: Root[] = []
beforeEach(() => {
  allowMoveLeavingBehind.mockClear()
  connect.mockClear()
  Object.assign(window, {
    api: {
      runtimeEnvironments: { managedOrcad: { allowMoveLeavingBehind } },
      ssh: { connect }
    }
  })
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

async function render(status: SshManagedServerStatus, onChanged = vi.fn()) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<SshHostMoveAnywayAction target={target} status={status} onChanged={onChanged} />)
  })
  return container
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!
}

describe('Move anyway', () => {
  it('is offered only for a refusal that saved state alone causes', async () => {
    expect((await render({ ...refused, canLeaveBehind: undefined })).textContent).toBe('')
    expect(
      (await render({ kind: 'relay', reason: 'relay_terminals_live', terminals: 2 })).textContent
    ).toBe('')
  })

  it('names what stays behind, then reconnects with consent recorded', async () => {
    const onChanged = vi.fn()
    const container = await render(refused, onChanged)
    await act(async () => button(container, 'Move anyway…').click())
    expect(container.textContent).toContain('unsaved changes to /etc/hosts')
    expect(container.textContent).toContain('Unsaved edits are kept, never deleted.')
    await act(async () => button(container, 'Move anyway').click())
    expect(allowMoveLeavingBehind).toHaveBeenCalledWith({ sshTargetId: 'ssh-1' })
    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(onChanged).toHaveBeenCalled()
  })
})
