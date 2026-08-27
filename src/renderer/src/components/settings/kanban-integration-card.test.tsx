// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanIntegrationCard } from './kanban-integration-card'
import { KANBAN_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'

const kanbanApi = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn()
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderCard(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  container = host
  root = createRoot(host)
  void act(() => {
    root?.render(<KanbanIntegrationCard />)
  })
  return host
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  kanbanApi.status.mockReset().mockResolvedValue({ connected: false, reason: 'missing' })
  kanbanApi.connect
    .mockReset()
    .mockResolvedValue({ ok: false, code: 'invalid_token', error: 'nope' })
  kanbanApi.disconnect.mockReset().mockResolvedValue(undefined)
  kanbanApi.listTasks.mockReset().mockResolvedValue({ tasks: [], lanes: [], receivedAt: '' })
  kanbanApi.getTask.mockReset().mockResolvedValue(null)
  globalThis.window.api = {
    kanban: {
      status: kanbanApi.status,
      connect: kanbanApi.connect,
      disconnect: kanbanApi.disconnect,
      listTasks: kanbanApi.listTasks,
      getTask: kanbanApi.getTask
    }
  } as never
})

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  container = null
})

describe('KanbanIntegrationCard', () => {
  it('renders the provider name and the fixed server copy', async () => {
    const host = renderCard()
    await flushEffects()
    expect(host.querySelector('[data-settings-section="integrations-kanban"]')).not.toBeNull()
    expect(host.textContent).toContain('Kanban')
    expect(host.textContent).toContain('https://kanban.fpimi.ru')
  })

  it('anchors the card to the Kanban settings section id', async () => {
    const host = renderCard()
    await flushEffects()
    expect(
      host.querySelector(`[data-settings-section="${KANBAN_INTEGRATION_SECTION_ID}"]`)
    ).not.toBeNull()
  })

  it('shows the connected viewer and a disconnect action', async () => {
    kanbanApi.status.mockResolvedValue({
      connected: true,
      viewer: { id: 'u1', name: 'User One', level: 'admin' }
    })
    const host = renderCard()
    await flushEffects()
    expect(host.textContent).toContain('Connected')
    expect(host.textContent).toContain('User One')
    const disconnectButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Disconnect')
    )
    expect(disconnectButton).toBeDefined()
    void act(() => {
      disconnectButton?.click()
    })
    await flushEffects()
    expect(kanbanApi.disconnect).toHaveBeenCalledOnce()
  })

  it('never echoes a typed token value anywhere in the rendered surface', async () => {
    const host = renderCard()
    await flushEffects()
    const connectButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Connect')
    )
    void act(() => {
      connectButton?.click()
    })
    await flushEffects()
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement | null
    expect(tokenInput).not.toBeNull()
    void act(() => {
      if (tokenInput) {
        tokenInput.value = 'sekret-token-123'
        tokenInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await flushEffects()
    expect(document.body.textContent ?? '').not.toContain('sekret-token-123')
  })
})
