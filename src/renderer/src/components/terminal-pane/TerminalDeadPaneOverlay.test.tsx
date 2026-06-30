// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalDeadPaneOverlay } from './TerminalDeadPaneOverlay'

const mountedRoots: Root[] = []

async function renderOverlay(props: {
  exitCode: number
  onRestart: () => void
  onClose: () => void
}): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<TerminalDeadPaneOverlay {...props} />)
  })
}

function getButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.includes(label)
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('TerminalDeadPaneOverlay', () => {
  it('shows a failure title and the non-zero exit code', async () => {
    await renderOverlay({ exitCode: 1, onRestart: vi.fn(), onClose: vi.fn() })
    expect(document.body.textContent).toContain('Terminal exited')
    expect(document.body.textContent).toContain('exit code 1')
  })

  it('shows a clean-close title for exit code 0', async () => {
    await renderOverlay({ exitCode: 0, onRestart: vi.fn(), onClose: vi.fn() })
    expect(document.body.textContent).toContain('Terminal closed')
    expect(document.body.textContent).toContain('exit code 0')
  })

  it('invokes onRestart and onClose from the action buttons', async () => {
    const onRestart = vi.fn()
    const onClose = vi.fn()
    await renderOverlay({ exitCode: 137, onRestart, onClose })

    await act(async () => {
      getButton('Restart').click()
    })
    expect(onRestart).toHaveBeenCalledTimes(1)

    await act(async () => {
      getButton('Close').click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
