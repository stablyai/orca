// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHealthSnapshot } from '../../../../shared/agent-health'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./tooltip', () => ({ formatTimeAgo: () => 'just now' }))

import { AgentHealthRows } from './AgentHealthRows'

describe('AgentHealthRows', () => {
  it('starts the available provider update from its button', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onCheck = vi.fn()
    const onUpdate = vi.fn()
    const snapshot: AgentHealthSnapshot = {
      provider: 'codex',
      cliStatus: 'available',
      health: 'healthy',
      version: '0.146.1',
      durationMs: 42,
      checkedAt: 1,
      checks: [{ id: 'cli', status: 'ok' }],
      latestVersion: '0.147.0',
      updateAvailability: 'available',
      updateSupported: true
    }

    act(() => {
      root.render(
        <AgentHealthRows
          snapshot={snapshot}
          connectionState="ready"
          pending={false}
          mode="compact"
          onCheck={onCheck}
          onUpdate={onUpdate}
        />
      )
    })
    act(() => container.querySelector('button')?.click())

    expect(onUpdate).toHaveBeenCalledWith('codex')
    expect(container.textContent).not.toContain('42 ms')

    act(() => root.unmount())
  })

  it('checks again without starting an update when availability is unknown', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onCheck = vi.fn()
    const onUpdate = vi.fn()
    const snapshot: AgentHealthSnapshot = {
      provider: 'claude',
      cliStatus: 'available',
      health: 'healthy',
      version: '1.0.61',
      durationMs: 42,
      checkedAt: 1,
      checks: [{ id: 'cli', status: 'ok' }],
      latestVersion: null,
      updateAvailability: 'unknown',
      updateSupported: true
    }

    act(() => {
      root.render(
        <AgentHealthRows
          snapshot={snapshot}
          connectionState="ready"
          pending={false}
          mode="compact"
          onCheck={onCheck}
          onUpdate={onUpdate}
        />
      )
    })
    act(() => container.querySelector('button')?.click())

    expect(container.textContent).toContain('Update status unavailable')
    expect(container.textContent).toContain('Check')
    expect(onCheck).toHaveBeenCalledWith('claude')
    expect(onUpdate).not.toHaveBeenCalled()

    act(() => root.unmount())
  })
})
