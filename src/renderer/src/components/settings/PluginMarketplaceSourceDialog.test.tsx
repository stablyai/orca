// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api-types'
import { PluginMarketplaceSourceDialog } from './PluginMarketplaceSourceDialog'

const source: PluginMarketplaceHostSourceState = {
  id: 'a'.repeat(32),
  source: { kind: 'git', url: 'git@example.com:team/plugins.git', ref: 'stable' },
  addedAt: 1,
  marketplace: {
    name: 'Team plugins',
    owner: 'example',
    resolvedCommit: 'b'.repeat(40),
    fetchedAt: 2
  },
  stale: false,
  official: false
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        addMarketplace: vi.fn().mockResolvedValue(source),
        refreshMarketplaces: vi.fn().mockResolvedValue([source]),
        removeMarketplace: vi.fn().mockResolvedValue([])
      }
    }
  })
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => installApi())

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PluginMarketplaceSourceDialog', () => {
  it('adds private SSH marketplaces through the system-Git source contract', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChanged = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <PluginMarketplaceSourceDialog
          open
          sources={[]}
          onOpenChange={vi.fn()}
          onChanged={onChanged}
        />
      )
    })
    const url = document.querySelector<HTMLInputElement>('#plugin-marketplace-url')
    const gitRef = document.querySelector<HTMLInputElement>('#plugin-marketplace-ref')
    if (!url || !gitRef) {
      throw new Error('missing marketplace source inputs')
    }
    await setInput(url, 'git@example.com:private/plugins.git')
    await setInput(gitRef, 'release')

    const add = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Add source'
    )
    await act(async () => add?.click())

    expect(window.api.plugins.addMarketplace).toHaveBeenCalledWith({
      kind: 'git',
      url: 'git@example.com:private/plugins.git',
      ref: 'release'
    })
    expect(onChanged).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it('dispatches per-source refresh and removal', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChanged = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <PluginMarketplaceSourceDialog
          open
          sources={[source]}
          onOpenChange={vi.fn()}
          onChanged={onChanged}
        />
      )
    })
    expect(document.querySelector('[role="dialog"]')?.classList).toContain('plugin-security-chrome')

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Refresh Team plugins"]')?.click()
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Remove Team plugins"]')?.click()
    )

    expect(window.api.plugins.refreshMarketplaces).toHaveBeenCalledWith({ sourceId: source.id })
    expect(window.api.plugins.removeMarketplace).toHaveBeenCalledWith({ sourceId: source.id })
    expect(onChanged).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})
