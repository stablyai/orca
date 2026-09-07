// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopActivityOverflowMenu, type ActivityBarItem } from './activity-bar-buttons'

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
})
