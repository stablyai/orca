// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginStatusBarItemSnapshot } from '../../../../shared/plugins/plugin-status-bar'
import type { ActivePluginCommand } from '@/store/plugin-panels'

const mocks = vi.hoisted(() => {
  const items: PluginStatusBarItemSnapshot[] = []
  const commands: ActivePluginCommand[] = []
  return {
    items,
    commands,
    executePluginCommand: vi.fn(async () => undefined),
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn()
  }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div data-tooltip>{children}</div>
}))
vi.mock('@/store/plugin-status-bar-items', () => ({
  usePluginStatusBarItems: (alignment: 'left' | 'right') =>
    mocks.items.filter((item) => item.alignment === alignment)
}))
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => mocks.commands }))
vi.mock('@/lib/plugin-command-execution', () => ({
  executePluginCommand: mocks.executePluginCommand
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeWorktreeId: null,
      setRightSidebarTab: mocks.setRightSidebarTab,
      setRightSidebarOpen: mocks.setRightSidebarOpen
    })
}))

const { PluginStatusBarItems, PluginStatusBarLeadingItems } = await import('./PluginStatusBarItems')

function item(overrides: Partial<PluginStatusBarItemSnapshot>): PluginStatusBarItemSnapshot {
  return {
    pluginKey: 'orca-samples.live-status',
    pluginName: 'Live Status',
    itemId: 'pulse',
    alignment: 'right',
    priority: 0,
    text: 'Pulse 1',
    severity: 'normal',
    ...overrides
  }
}

const command = (context: 'global' | 'worktree'): ActivePluginCommand => ({
  id: 'live-status-reset',
  title: 'Reset',
  context,
  handler: { type: 'worker' },
  keybindings: [],
  pluginKey: 'orca-samples.live-status',
  pluginName: 'Live Status'
})

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  return container
}

beforeEach(() => {
  mocks.items = []
  mocks.commands = []
  vi.clearAllMocks()
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('PluginStatusBarItems', () => {
  it('renders plugin text as plain text with plugin attribution', async () => {
    mocks.items = [item({ text: '<b>CPU</b> 42%', tooltip: 'CPU load', severity: 'warning' })]
    const view = await render(<PluginStatusBarItems alignment="right" />)
    const segment = view.querySelector('[data-plugin-status-item="orca-samples.live-status/pulse"]')

    expect(segment?.textContent).toBe('<b>CPU</b> 42%')
    expect(view.querySelector('b')).toBeNull()
    expect(segment?.getAttribute('data-severity')).toBe('warning')
    expect(segment?.getAttribute('aria-label')).toBe('CPU load, from the Live Status plugin')
    expect(view.querySelector('[data-tooltip]')?.textContent).toContain(
      'From the Live Status plugin'
    )
  })

  it('runs the contributed command on click', async () => {
    mocks.items = [item({ command: 'live-status-reset' })]
    mocks.commands = [command('global')]
    const view = await render(<PluginStatusBarItems alignment="right" />)
    await act(async () => view.querySelector('button')?.click())

    expect(mocks.executePluginCommand).toHaveBeenCalledWith(mocks.commands[0], 'plugin-status-bar')
  })

  it('is not clickable when its command needs a worktree and none is active', async () => {
    mocks.items = [item({ command: 'live-status-reset' })]
    mocks.commands = [command('worktree')]
    const view = await render(<PluginStatusBarItems alignment="right" />)

    expect(view.querySelector('button')).toBeNull()
  })

  it('opens the contributed panel on click', async () => {
    mocks.items = [item({ panelTabKey: 'plugin:orca-samples.live-status/live' })]
    const view = await render(<PluginStatusBarItems alignment="right" />)
    await act(async () => view.querySelector('button')?.click())

    expect(mocks.setRightSidebarTab).toHaveBeenCalledWith('plugin:orca-samples.live-status/live')
    expect(mocks.setRightSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('renders the leading container only when left-aligned items exist', async () => {
    const containerRef = vi.fn()
    mocks.items = [item({ alignment: 'right' })]
    const empty = await render(<PluginStatusBarLeadingItems containerRef={containerRef} />)
    expect(empty.innerHTML).toBe('')

    mocks.items = [item({ alignment: 'left', itemId: 'open' })]
    await act(async () => root?.render(<PluginStatusBarLeadingItems containerRef={containerRef} />))
    expect(containerRef).toHaveBeenCalledWith(expect.any(HTMLDivElement))
    expect(empty.querySelector('[data-plugin-status-item$="/open"]')?.textContent).toBe('Pulse 1')
  })
})
