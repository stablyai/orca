// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadManagedRestartResult } from '../../../../shared/orcad-managed-runtime'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { SshHostRestartServerAction } from './SshHostRestartServerAction'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const ended: SshManagedServerStatus = {
  kind: 'managed',
  environmentId: 'env-1',
  launchSessionEnded: true
}

const restart = vi.fn(async (): Promise<OrcadManagedRestartResult> => ({
  outcome: 'restarted',
  environmentId: 'env-1'
}))
const roots: Root[] = []
beforeEach(() => {
  restart.mockClear()
  Object.assign(window, { api: { runtimeEnvironments: { managedOrcad: { restart } } } })
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
    root.render(<SshHostRestartServerAction status={status} onChanged={onChanged} />)
  })
  return container
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!
}

describe('Restart managed server', () => {
  it('is offered only when the launching SSH session proved ended', async () => {
    expect((await render({ kind: 'managed', environmentId: 'env-1' })).textContent).toBe('')
  })

  it('confirms first, then restarts and refreshes', async () => {
    const onChanged = vi.fn()
    const container = await render(ended, onChanged)
    await act(async () => button(container, 'Restart managed server…').click())
    expect(restart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('no terminals are running')
    await act(async () => button(container, 'Restart').click())
    expect(restart).toHaveBeenCalledWith({ selector: 'env-1' })
    expect(onChanged).toHaveBeenCalled()
  })

  it.each([
    [{ outcome: 'terminals-running', liveSessions: 2 } as const, '2 terminals are still running'],
    [{ outcome: 'terminals-running', liveSessions: null } as const, 'couldn’t confirm whether'],
    [{ outcome: 'not-restarted', reason: 'fenced elsewhere' } as const, 'fenced elsewhere']
  ])('says why main kept the server running: %o', async (result, text) => {
    restart.mockResolvedValueOnce(result)
    const onChanged = vi.fn()
    const container = await render(ended, onChanged)
    await act(async () => button(container, 'Restart managed server…').click())
    await act(async () => button(container, 'Restart').click())
    expect(container.textContent).toContain(text)
    expect(onChanged).not.toHaveBeenCalled()
  })
})
