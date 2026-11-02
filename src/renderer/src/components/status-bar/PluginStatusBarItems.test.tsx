// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginStatusBarItem } from '@/store/plugin-status-bar-items'
import { TooltipProvider } from '@/components/ui/tooltip'

const items: ActivePluginStatusBarItem[] = []
const executePluginCommand = vi.fn()

vi.mock('@/store/plugin-status-bar-items', () => ({ usePluginStatusBarItems: () => items }))
vi.mock('@/lib/plugin-command-execution', () => ({
  executePluginCommand: (...args: unknown[]) => executePluginCommand(...args)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { PluginStatusBarItems } from './PluginStatusBarItems'

const command = {
  id: 'guard.log',
  title: 'Show log',
  context: 'global' as const,
  handler: { type: 'worker' as const },
  keybindings: [],
  pluginKey: 'acme.guard',
  pluginName: 'Guard'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  executePluginCommand.mockReset().mockResolvedValue(undefined)
  items.length = 0
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(iconOnly = false): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <PluginStatusBarItems iconOnly={iconOnly} />
      </TooltipProvider>
    )
  )
}

describe('PluginStatusBarItems', () => {
  it('runs the item command when pressed and shows its tone', async () => {
    items.push({
      key: 'acme.guard/blocked',
      pluginName: 'Guard',
      text: '2 blocked',
      icon: 'flag',
      tone: 'warning',
      tooltip: 'Blocked commands',
      command
    })
    await render()
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('2 blocked')
    expect(button?.dataset.tone).toBe('warning')
    expect(button?.getAttribute('aria-label')).toBe('2 blocked, Blocked commands')
    await act(async () => button?.click())
    expect(executePluginCommand).toHaveBeenCalledWith(command, 'plugin-palette')
  })

  it('draws an item without a command as static text, icon only when the bar is narrow', async () => {
    items.push({
      key: 'acme.guard/quiet',
      pluginName: 'Guard',
      text: 'Quiet',
      icon: 'bell',
      tone: 'neutral',
      tooltip: 'Guard',
      command: null
    })
    await render(true)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toBe('')
  })
})
