// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CloseTerminalDialog from './CloseTerminalDialog'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

const mountedRoots: Root[] = []

async function renderDialog(props: {
  copyKind?: 'command' | 'agent'
  onConfirm: (dontAskAgain: boolean) => void
  onCancel?: () => void
}): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <CloseTerminalDialog
        open
        copyKind={props.copyKind}
        onCancel={props.onCancel ?? vi.fn()}
        onConfirm={props.onConfirm}
      />
    )
  })
}

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  button.click()
}

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('CloseTerminalDialog', () => {
  it('renders running command copy and confirms without skipping by default', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'command', onConfirm })

    await act(async () => {
      clickButton('Stop and Close')
    })

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('renders agent copy and passes the skip preference when checked', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'agent', onConfirm })

    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox?.click()
    })
    await act(async () => {
      clickButton('Stop Agent')
    })

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('resets the skip preference when the dialog closes and reopens', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)
    const render = async (open: boolean): Promise<void> => {
      await act(async () => {
        root.render(<CloseTerminalDialog open={open} onCancel={onCancel} onConfirm={onConfirm} />)
      })
    }

    await render(true)
    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    await act(async () => {
      checkbox?.click()
    })
    expect(checkbox?.getAttribute('aria-checked')).toBe('true')

    await render(false)
    await render(true)

    expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
      'false'
    )
  })
})
