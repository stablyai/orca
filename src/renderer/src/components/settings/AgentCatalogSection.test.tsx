// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentCatalogSection } from './AgentCatalogSection'
import { buildLocalCatalogSnapshot } from './agent-catalog-snapshot.fixture'

// The catalog owns its detection view; mock the detection hook and drive the
// real useLocalAgentCatalog hook off a mocked preload (the connected-path oracle).
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    isLoading: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

function isRowElement(el: HTMLElement): boolean {
  return typeof el.hasAttribute === 'function' && el.hasAttribute('data-agent-catalog-row')
}

let restore: (() => void) | undefined
beforeEach(() => {
  const getLocal = vi.fn().mockResolvedValue(buildLocalCatalogSnapshot({}))
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      agentCatalog: { getLocal },
      onChanged: () => () => {}
    }
  }
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const height = isRowElement(this) ? 52 : 500
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: height,
      width: 400,
      height,
      toJSON() {}
    }
  }
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isRowElement(this) ? 52 : 500
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 400
  })
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
    if (offsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    }
  }
})

afterEach(() => {
  restore?.()
  cleanup()
})

describe('AgentCatalogSection (connected)', () => {
  it('fetches the local snapshot and renders built-in rows from it', async () => {
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    // First paint is the loading state until the mocked getLocal resolves.
    expect(screen.getByText('Loading agents…')).toBeTruthy()
    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(screen.getByText('Agents')).toBeTruthy()
  })

  it('surfaces a migration-blocked mutation as a persistent read-only alert', async () => {
    // Claude starts disabled so the toggle takes the direct (confirmation-free)
    // enable path, which previously dropped the rejected result silently.
    const getLocal = vi
      .fn()
      .mockResolvedValue(buildLocalCatalogSnapshot({ disabledAgents: ['claude'] }))
    const mutate = vi.fn().mockResolvedValue({
      ok: false,
      code: 'agent_catalog_migration_blocked',
      migrationError: 'backup failed: disk full'
    })
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal, mutate },
        onChanged: () => () => {}
      }
    }
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    fireEvent.click(await screen.findByLabelText('Enable Claude'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Agent settings are temporarily read-only')).toBeTruthy()
    expect(screen.getByText('backup failed: disk full')).toBeTruthy()
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('tells the user a toggle whose durable write failed was not saved', async () => {
    const getLocal = vi
      .fn()
      .mockResolvedValue(buildLocalCatalogSnapshot({ disabledAgents: ['claude'] }))
    const mutate = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'agent_catalog_write_failed', revision: 2 })
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal, mutate },
        onChanged: () => () => {}
      }
    }
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    fireEvent.click(await screen.findByLabelText('Enable Claude'))
    expect(await screen.findByText("Your change wasn't saved")).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('nothing was changed')
  })

  it('surfaces the migration block from the load-time snapshot before any mutation', async () => {
    const getLocal = vi
      .fn()
      .mockResolvedValue(buildLocalCatalogSnapshot({ migrationBlockedError: 'disk full' }))
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal },
        onChanged: () => () => {}
      }
    }
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Agent settings are temporarily read-only')).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
  })

  it('surfaces a schema-too-new rejection as a non-retryable read-only alert', async () => {
    const getLocal = vi
      .fn()
      .mockResolvedValue(buildLocalCatalogSnapshot({ disabledAgents: ['claude'] }))
    const mutate = vi.fn().mockResolvedValue({
      ok: false,
      code: 'agent_catalog_schema_too_new',
      persistedVersion: 2,
      supportedVersion: 1
    })
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal, mutate },
        onChanged: () => () => {}
      }
    }
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    fireEvent.click(await screen.findByLabelText('Enable Claude'))
    expect(
      await screen.findByText('Custom agents are read-only in this version of Orca')
    ).toBeTruthy()
    expect(
      screen.getByText('Profile agent catalog v2; this version of Orca supports v1.')
    ).toBeTruthy()
    // Not a disk failure: the "wasn't saved, try again" copy must stay away.
    expect(screen.queryByText("Your change wasn't saved")).toBeNull()
  })

  it('surfaces the read-only state from the load-time snapshot before any mutation', async () => {
    const getLocal = vi.fn().mockResolvedValue(
      buildLocalCatalogSnapshot({
        schemaTooNew: { persistedVersion: 4, supportedVersion: 1 }
      })
    )
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal },
        onChanged: () => () => {}
      }
    }
    render(<AgentCatalogSection agentCmdOverrides={{}} />)
    expect(
      await screen.findByText('Custom agents are read-only in this version of Orca')
    ).toBeTruthy()
  })

  it('keeps catalog search usable in read-only mode while controls stay disabled', async () => {
    render(<AgentCatalogSection agentCmdOverrides={{}} readOnly />)
    const search = (await screen.findByLabelText('Search agents')) as HTMLInputElement
    // The search input must not sit inside any disabled fieldset scope.
    expect(search.closest('fieldset[disabled]')).toBeNull()
    const enableSwitch = screen.getByLabelText('Enable Claude')
    expect(enableSwitch.closest('fieldset')?.hasAttribute('disabled')).toBe(true)
    fireEvent.change(search, { target: { value: 'zzz-no-such-agent' } })
    expect(screen.getByText('No agents match your search.')).toBeTruthy()
  })
})
