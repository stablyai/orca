// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshManagedServerMoveDialog } from './SshManagedServerMoveDialog'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const moveToManagedServer = vi.fn()
const roots: Root[] = []

beforeEach(() => {
  moveToManagedServer.mockReset()
  Object.assign(window, { api: { ssh: { moveToManagedServer } } })
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'api')
})

function render(onClose = vi.fn()): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      <SshManagedServerMoveDialog
        open
        targetId="ssh-1"
        host="Box"
        terminals={3}
        onClose={onClose}
      />
    )
  )
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent === label
  )
  if (!found) {
    throw new Error(`No "${label}" button`)
  }
  return found
}

describe('SshManagedServerMoveDialog', () => {
  it('explains the reliability gain and that the open terminals restart', () => {
    const container = render()
    expect(container.textContent).toContain('Move to managed server')
    expect(container.textContent).toContain(
      'Move Box to a managed Orca server for more reliable connections. Its 3 open terminals will restart.'
    )
    expect(button(container, 'Not now')).toBeTruthy()
  })

  it('"Not now" closes without moving', () => {
    const onClose = vi.fn()
    const container = render(onClose)
    act(() => button(container, 'Not now').click())
    expect(onClose).toHaveBeenCalled()
    expect(moveToManagedServer).not.toHaveBeenCalled()
  })

  it('closes after the host moved', async () => {
    moveToManagedServer.mockResolvedValue({ outcome: 'moved', environmentId: 'env-1' })
    const onClose = vi.fn()
    const container = render(onClose)
    await act(async () => button(container, 'Move').click())
    expect(moveToManagedServer).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows why a move was refused and keeps the dialog open', async () => {
    moveToManagedServer.mockResolvedValue({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 2
    })
    const onClose = vi.fn()
    const container = render(onClose)
    await act(async () => button(container, 'Move').click())
    expect(container.textContent).toContain(
      'Not moved: Orca couldn’t confirm that 2 terminals on Box stopped.'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(button(container, 'Close')).toBeTruthy()

    moveToManagedServer.mockResolvedValue({ outcome: 'moved', environmentId: 'env-1' })
    await act(async () => button(container, 'Try again').click())
    expect(moveToManagedServer).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a move that failed outright', async () => {
    moveToManagedServer.mockRejectedValue(new Error('relay offline'))
    const container = render()
    await act(async () => button(container, 'Move').click())
    expect(container.textContent).toContain('Could not move Box: relay offline')
  })

  it('a dialog remounted mid-move keeps Move disabled and never starts a second move', async () => {
    let finish: (value: unknown) => void = () => {}
    moveToManagedServer.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const first = render()
    act(() => button(first, 'Move').click())
    act(() => roots.shift()?.unmount())

    const second = render()
    expect(button(second, 'Move').disabled).toBe(true)
    act(() => button(second, 'Move').click())
    expect(moveToManagedServer).toHaveBeenCalledTimes(1)
    await act(async () => finish({ outcome: 'refused', verdict: 'live', terminals: 2 }))
    expect(second.textContent).toContain('Not moved: 2 terminals on Box are still running.')
  })
})
