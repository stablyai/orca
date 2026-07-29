// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadOptionsMenu } from './ActivityPrototypePage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  compactMode = false,
  hasUnreadThreads = true
}: {
  compactMode?: boolean
  hasUnreadThreads?: boolean
}): ReactElement {
  return (
    <TooltipProvider>
      <ActivityThreadOptionsMenu
        compactMode={compactMode}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={vi.fn()}
        onMarkAllThreadsRead={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('ActivityThreadOptionsMenu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('opens without recursively updating composed Radix trigger refs', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    expect(trigger).not.toBeNull()
    expect(trigger?.parentElement?.tagName).toBe('SPAN')

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Compact mode')
  })
})
