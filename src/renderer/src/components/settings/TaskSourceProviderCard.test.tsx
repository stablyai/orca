// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskSourceProviderCard } from './TaskSourceProviderCard'

const readiness = {
  connected: false,
  checking: false,
  skillInstalled: false,
  skillChecking: false,
  visible: true
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
})

describe('TaskSourceProviderCard', () => {
  it('stays expanded when the auto-expand target moves to another provider', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const card = (defaultExpanded: boolean): React.JSX.Element => (
      <TaskSourceProviderCard
        icon={<span />}
        name="Linear"
        description="Linear setup"
        readiness={readiness}
        visible
        canHide
        defaultExpanded={defaultExpanded}
        onToggleVisible={vi.fn()}
      >
        <span>Install terminal</span>
      </TaskSourceProviderCard>
    )

    await act(async () => {
      root?.render(card(true))
    })
    expect(container.textContent).toContain('Install terminal')

    // A slower provider check makes another card the auto-expand target.
    await act(async () => {
      root?.render(card(false))
    })

    expect(container.textContent).toContain('Install terminal')
  })
})
