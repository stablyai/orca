// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CopyCommentsPromptButton } from './pr-comments-copy-prompt-button'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(props: {
  label?: string
  disabled?: boolean
  disabledReason?: string
  onCopy: () => Promise<boolean>
}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <CopyCommentsPromptButton label={props.label ?? 'Copy prompt'} {...props} />
      </TooltipProvider>
    )
  })
}

function button(): HTMLButtonElement {
  const el = container.querySelector('button')
  if (!el) {
    throw new Error('Copy button not found')
  }
  return el
}

// Why: the success icon (`Check`) is the only node carrying the success token; its
// presence is the observable proof the button honored the copy result.
function hasSuccessIcon(): boolean {
  return container.querySelector('.text-status-success') !== null
}

async function click(): Promise<void> {
  await act(async () => {
    button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  // Why: the click starts an awaited clipboard promise; flush its microtask + re-render.
  await act(async () => {})
}

describe('CopyCommentsPromptButton', () => {
  it('swaps to the success icon and accessible name when the copy resolves true', async () => {
    const onCopy = vi.fn().mockResolvedValue(true)
    render({ label: 'Copy prompt', onCopy })

    expect(hasSuccessIcon()).toBe(false)
    expect(button().getAttribute('aria-label')).toBe('Copy prompt')
    await click()

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(hasSuccessIcon()).toBe(true)
    // Why: the copied state must reach assistive tech, not only the icon.
    expect(button().getAttribute('aria-label')).toBe('Copied prompt to clipboard')
  })

  it('does not signal success when the copy resolves false', async () => {
    const onCopy = vi.fn().mockResolvedValue(false)
    render({ onCopy })

    await click()

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(hasSuccessIcon()).toBe(false)
  })

  it('does not invoke onCopy while disabled', () => {
    const onCopy = vi.fn().mockResolvedValue(true)
    render({ disabled: true, disabledReason: 'Comments are still loading.', onCopy })

    expect(button().disabled).toBe(true)
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onCopy).not.toHaveBeenCalled()
  })

  it('ignores a re-entrant click while a copy is already in flight', async () => {
    let resolveCopy: (value: boolean) => void = () => {}
    const onCopy = vi.fn(() => new Promise<boolean>((resolve) => (resolveCopy = resolve)))
    render({ onCopy })

    // First click starts an in-flight copy; a second click before it resolves must be dropped.
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCopy).toHaveBeenCalledTimes(1)

    // Once it settles, the button accepts a fresh copy again.
    await act(async () => {
      resolveCopy(true)
    })
    await act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCopy).toHaveBeenCalledTimes(2)
  })
})
