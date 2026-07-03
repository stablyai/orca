// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CloseTerminalDialog from './CloseTerminalDialog'

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

describe('CloseTerminalDialog', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('renders running command copy and confirms without skipping by default', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'command', onConfirm })

    expect(document.body.textContent).toContain('Stop running command?')
    expect(document.body.textContent).toContain(
      'Closing this terminal will stop the command running inside it.'
    )

    await act(async () => {
      clickButton('Stop and Close')
    })

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('renders agent copy and passes the skip preference when checked', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'agent', onConfirm })

    expect(document.body.textContent).toContain('Stop this agent?')
    expect(document.body.textContent).toContain(
      "Closing this terminal will stop the agent's current work."
    )

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
})
