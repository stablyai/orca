// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  listStageNames: vi.fn<() => Promise<string[]>>()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/runtime/runtime-odoo-client', () => ({
  odooListStageNames: () => mocks.listStageNames()
}))

const storeState = {
  settings: { activeRuntimeEnvironmentId: null },
  odooStatus: { connected: true, viewer: null }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

const status: WorkspaceStatusDefinition = { id: 'in_progress', label: 'In progress' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.listStageNames.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function content(): HTMLElement | null {
  return document.querySelector('[data-slot="popover-content"]')
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text
  )
}

async function openPopover(): Promise<void> {
  const { default: WorkspaceStatusOdooStagePopover } =
    await import('./WorkspaceStatusOdooStagePopover')
  await act(async () =>
    root.render(<WorkspaceStatusOdooStagePopover status={status} onChange={vi.fn()} />)
  )
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Link an Odoo stage"]'
  )
  if (!trigger) {
    throw new Error('Missing Odoo stage trigger')
  }
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('WorkspaceStatusOdooStagePopover', () => {
  it('reports a failed stage read instead of an empty stage list', async () => {
    mocks.listStageNames.mockRejectedValue(new Error('rpc down'))

    await openPopover()

    expect(content()?.textContent).toContain('Could not load stages.')
    expect(content()?.textContent).not.toContain('No stage matches.')
  })

  it('reloads the stage names when the failure state is retried', async () => {
    mocks.listStageNames.mockRejectedValueOnce(new Error('rpc down'))
    mocks.listStageNames.mockResolvedValueOnce(['Ready', 'In Progress'])

    await openPopover()
    const retry = buttonWithText('Retry')
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.listStageNames).toHaveBeenCalledTimes(2)
    expect(content()?.textContent).not.toContain('Could not load stages.')
    expect(content()?.textContent).toContain('In Progress')
  })

  it('reports an empty stage list when the read succeeds with no stages', async () => {
    mocks.listStageNames.mockResolvedValue([])

    await openPopover()

    expect(content()?.textContent).toContain('No stage matches.')
    expect(content()?.textContent).not.toContain('Could not load stages.')
  })

  // A stage the server no longer returns is kept so the user can clear it, but
  // cmdk runs with shouldFilter={false}, so nothing else keeps it out of a
  // search it does not match.
  it('hides a retained mapped stage from searches it does not match', async () => {
    mocks.listStageNames.mockResolvedValue(['In Progress', 'Done'])
    const { default: WorkspaceStatusOdooStagePopover } =
      await import('./WorkspaceStatusOdooStagePopover')
    await act(async () =>
      root.render(
        <WorkspaceStatusOdooStagePopover
          status={{ ...status, odooStageName: 'Retired stage' }}
          onChange={vi.fn()}
        />
      )
    )
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Link an Odoo stage"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(content()?.textContent).toContain('Retired stage')

    const search = content()?.querySelector('input')
    if (!search) {
      throw new Error('Missing stage search input')
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'Done'
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(content()?.textContent).toContain('Done')
    expect(content()?.textContent).not.toContain('Retired stage')
  })
})
