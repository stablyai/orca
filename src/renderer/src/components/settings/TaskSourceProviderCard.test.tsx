// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
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
  it('shows the visibility action in only one place when expanded', () => {
    const markup = renderToStaticMarkup(
      <TaskSourceProviderCard
        icon={<span />}
        name="Linear"
        description="Linear setup"
        readiness={readiness}
        visible
        canHide
        defaultExpanded
        onToggleVisible={vi.fn()}
      >
        <button aria-label="Hide Linear from Tasks">Shown</button>
      </TaskSourceProviderCard>
    )

    expect(markup.match(/aria-label="Hide Linear from Tasks"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Collapse Linear setup steps"')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('keeps visibility available while setup steps are collapsed', () => {
    const markup = renderToStaticMarkup(
      <TaskSourceProviderCard
        icon={<span />}
        name="Linear"
        description="Linear setup"
        readiness={readiness}
        visible
        canHide
        defaultExpanded={false}
        onToggleVisible={vi.fn()}
      >
        <span>Expanded content</span>
      </TaskSourceProviderCard>
    )

    expect(markup).toContain('aria-label="Hide Linear from Tasks"')
    expect(markup).not.toContain('aria-pressed')
    expect(markup).toContain('>Hide</button>')
    expect(markup).not.toContain('>Shown</button>')
    expect(markup).toContain('aria-label="Show Linear setup steps"')
    expect(markup).not.toContain('Expanded content')
  })

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

  it('labels the locked final provider as shown instead of offering a hide action', () => {
    const markup = renderToStaticMarkup(
      <TaskSourceProviderCard
        icon={<span />}
        name="Linear"
        description="Linear setup"
        readiness={readiness}
        visible
        canHide={false}
        defaultExpanded={false}
        onToggleVisible={vi.fn()}
      />
    )

    // aria-disabled, not disabled: the explanation must stay keyboard reachable.
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain(
      'aria-label="Linear is shown in Tasks. At least one provider must stay visible."'
    )
    expect(markup).toContain('>Shown</button>')
    expect(markup).not.toContain('>Hide</button>')
  })
})
