// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SshTargetDestructiveActions,
  type SshBulkRemoveRequest,
  type SshBulkRemoveResult
} from './SshTargetDestructiveActions'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((entry) => entry.textContent === text)
}

async function renderBulk(
  request: SshBulkRemoveRequest,
  removeQuietly: (id: string) => Promise<void>,
  onFinished: (result: SshBulkRemoveResult) => void
): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <SshTargetDestructiveActions
        onRemove={vi.fn()}
        removeQuietly={removeQuietly}
        onBulkRemoveFinished={onFinished}
      >
        {({ requestBulkRemove }) => (
          <button onClick={() => requestBulkRemove(request)}>open bulk</button>
        )}
      </SshTargetDestructiveActions>
    )
  })
  await act(async () => button('open bulk')?.click())
}

describe('bulk SSH host removal', () => {
  it('lists the hosts in one confirm and removes them one by one with progress', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const refusal = new Error('refused')
    const removeQuietly = vi.fn(async (id: string) => {
      order.push(id)
      if (id === 'a') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      if (id === 'b') {
        throw refusal
      }
    })
    const onFinished = vi.fn()
    await renderBulk(
      {
        targets: [
          { id: 'a', label: 'alpha' },
          { id: 'b', label: 'beta' },
          { id: 'c', label: 'gamma' }
        ],
        connectedCount: 1
      },
      removeQuietly,
      onFinished
    )
    expect(document.body.textContent).toContain('Remove 3 SSH hosts?')
    expect([...document.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
    expect(document.body.textContent).toContain('1 host is connected')
    expect(document.body.textContent).toContain('later syncs won’t bring them back')

    await act(async () => {
      button('Remove 3')?.click()
    })
    expect(document.body.textContent).toContain('Removing 1 of 3…')
    expect(removeQuietly).toHaveBeenCalledTimes(1)

    await act(async () => releaseFirst())
    expect(order).toEqual(['a', 'b', 'c'])
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({
      removed: [
        { id: 'a', label: 'alpha' },
        { id: 'c', label: 'gamma' }
      ],
      failed: [{ target: { id: 'b', label: 'beta' }, error: refusal }]
    })
    expect(document.body.textContent).not.toContain('Remove 3 SSH hosts?')
  })
})

describe('the bulk confirm list', () => {
  it('shows the first eight names and a count past ten', async () => {
    const targets = Array.from({ length: 12 }, (_, index) => ({
      id: `h${index}`,
      label: `host-${index}`
    }))
    await renderBulk({ targets, connectedCount: 0 }, vi.fn(), vi.fn())
    const items = [...document.querySelectorAll('li')].map((item) => item.textContent)
    expect(items).toHaveLength(9)
    expect(items.at(-1)).toBe('+4 more')
  })
})
