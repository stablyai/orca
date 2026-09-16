// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ActivityBarButton,
  TopActivityOverflowMenu,
  type ActivityBarItem
} from './activity-bar-buttons'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const roots: ReturnType<typeof createRoot>[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('TopActivityOverflowMenu', () => {
  it('announces a hidden plugin panel error from the More button', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const item: ActivityBarItem = {
      id: 'plugin:orca-samples.demo/dashboard',
      icon: () => <span />,
      title: 'Demo',
      shortcut: '',
      statusIndicator: 'failure'
    }

    await act(async () => {
      root.render(
        <TopActivityOverflowMenu items={[item]} activeTab="explorer" onSelect={vi.fn()} />
      )
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'More sidebar tabs — Error'
    )
  })

  it('announces hidden cancelled checks from the More button', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const item: ActivityBarItem = {
      id: 'checks',
      icon: () => <span />,
      title: 'Checks',
      shortcut: ''
    }

    await act(async () => {
      root.render(
        <TopActivityOverflowMenu
          items={[item]}
          activeTab="explorer"
          onSelect={vi.fn()}
          checksStatus="cancelled"
        />
      )
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'More sidebar tabs — Checks cancelled'
    )
  })
})

describe('ActivityBarButton', () => {
  it('announces cancelled checks on the visible button', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const item: ActivityBarItem = {
      id: 'checks',
      icon: () => <span />,
      title: 'Checks',
      shortcut: '⌘8'
    }

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityBarButton
            item={item}
            active={false}
            onClick={vi.fn()}
            layout="top"
            statusIndicator="cancelled"
          />
        </TooltipProvider>
      )
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Checks (⌘8) — Cancelled'
    )
  })
})
