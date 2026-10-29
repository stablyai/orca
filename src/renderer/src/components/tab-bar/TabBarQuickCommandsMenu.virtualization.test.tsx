// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import { TabBarQuickCommandsMenu } from './TabBarQuickCommandsMenu'

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutKeyComboDetails: () => [] }))
vi.mock('./tab-bar-quick-commands-shortcut', () => ({
  useTabBarQuickCommandsShortcut: () => undefined
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null,
  getAgentLabel: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

const ROW_HEIGHT = 56
const VIEWPORT_HEIGHT = 288
const COMMAND_COUNT = 500
const commands: HostedTerminalQuickCommand[] = Array.from({ length: COMMAND_COUNT }, (_, index) => {
  const hostId = index < 250 ? 'local' : 'runtime:remote'
  return {
    key: `${hostId}\0command-${index % 250}`,
    hostId,
    hostLabel: hostId === 'local' ? 'This Mac' : 'Remote',
    command: {
      id: `command-${index % 250}`,
      label: `Command ${String(index).padStart(3, '0')}`,
      action: 'terminal-command',
      command: `echo ${index}`,
      appendEnter: true,
      scope: index < 250 ? { type: 'repo', repoId: 'repo' } : { type: 'global' }
    }
  }
})

beforeEach(() => {
  Object.assign(window, {
    api: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
  })
  // happy-dom has no layout; keep the real virtualizer and supply browser geometry.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('cmdk-list') ? VIEWPORT_HEIGHT : ROW_HEIGHT
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('cmdk-list') ? VIEWPORT_HEIGHT : ROW_HEIGHT
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const shell = this.querySelector<HTMLElement>('[data-testid="virtualized-list"]')
    return shell ? Number.parseFloat(shell.style.height) : VIEWPORT_HEIGHT
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const scrollTop = this.closest('[cmdk-list]')?.scrollTop ?? 0
    return new DOMRect(
      0,
      this.hasAttribute('cmdk-list') ? 0 : -scrollTop,
      320,
      this.hasAttribute('cmdk-list') ? VIEWPORT_HEIGHT : ROW_HEIGHT
    )
  })
  vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (
    this: Element,
    options?: ScrollToOptions | number
  ) {
    this.scrollTop = typeof options === 'object' ? (options.top ?? this.scrollTop) : (options ?? 0)
    queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
  })
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openMenu(mostRecentIndex = 0, commandCount = COMMAND_COUNT) {
  const onRunCommand = vi.fn()
  const onEditCommand = vi.fn()
  const onDeleteCommand = vi.fn()
  render(
    <TooltipProvider>
      <TabBarQuickCommandsMenu
        isFocused
        repoCommands={commands.slice(0, Math.min(250, commandCount))}
        globalCommands={commands.slice(250, commandCount)}
        mostRecent={commands[mostRecentIndex]}
        addHosts={[
          { hostId: 'local', label: 'This Mac', commands: [] },
          { hostId: 'runtime:remote', label: 'Remote', commands: [] }
        ]}
        hostLoadFailed={false}
        hostOwnershipPending={false}
        onAddCommand={vi.fn()}
        onDeleteCommand={onDeleteCommand}
        onEditCommand={onEditCommand}
        onMenuOpen={vi.fn()}
        onRunCommand={onRunCommand}
      />
    </TooltipProvider>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More quick commands' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  const input = await screen.findByRole('combobox')
  const list = screen.getByRole('listbox')
  await waitFor(() => expect(list.querySelectorAll('[role="option"]').length).toBeGreaterThan(0))
  return { input, list, onRunCommand, onEditCommand, onDeleteCommand }
}

function selectedRow(list: HTMLElement): HTMLElement | null {
  return list.querySelector('[role="option"][data-selected="true"]')
}

function expectWindowed(list: HTMLElement): void {
  expect(list.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(40)
}

describe('quick command dropdown virtualization', () => {
  it('virtualizes a single host at the saved-command limit', async () => {
    const { list } = await openMenu(0, 40)
    expect(list.querySelector('[data-testid="virtualized-list"]')).not.toBeNull()
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(30)
  })

  it('mounts a bounded window and keeps distant command actions attached to their host', async () => {
    const { list, onRunCommand, onEditCommand } = await openMenu()
    expectWindowed(list)
    expect(screen.queryByRole('button', { name: 'Copy Command 300' })).toBeNull()

    fireEvent.scroll(list, { target: { scrollTop: 300 * ROW_HEIGHT } })
    const copy = await screen.findByRole('button', { name: 'Copy Command 300' })
    expectWindowed(list)
    fireEvent.click(copy)
    await waitFor(() => expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith('echo 300'))
    expect(onRunCommand).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Command 300' }))
    expect(onEditCommand).toHaveBeenCalledExactlyOnceWith(commands[300])
    expect(onRunCommand).not.toHaveBeenCalled()
  })

  it('reveals an offscreen recent command and wraps keyboard navigation across the full list', async () => {
    const { input, list, onRunCommand } = await openMenu(499)
    await waitFor(() =>
      expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[499].key)
    )
    expect(list.scrollTop).toBeGreaterThan(400 * ROW_HEIGHT)
    expectWindowed(list)
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedRow(list)?.id)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[0].key))
    expect(list.scrollTop).toBe(0)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() =>
      expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[499].key)
    )
    expect(list.scrollTop).toBeGreaterThan(400 * ROW_HEIGHT)
    expectWindowed(list)
    fireEvent.keyDown(input, { key: 'Home' })
    await waitFor(() => expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[0].key))
    fireEvent.keyDown(input, { key: 'End' })
    await waitFor(() =>
      expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[499].key)
    )
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[0].key))
    fireEvent.keyDown(input, { key: 'p', ctrlKey: true })
    await waitFor(() =>
      expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[499].key)
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRunCommand).toHaveBeenCalledExactlyOnceWith(commands[499])
  })

  it('filters a scrolled list to a distant match, handles no results, and restores windowing', async () => {
    const { input, list, onRunCommand } = await openMenu(400)
    fireEvent.change(input, { target: { value: 'Command 499' } })
    await waitFor(() => expect(list.querySelectorAll('[role="option"]').length).toBe(1))
    expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[499].key)
    expect(list.querySelector('[data-testid="virtualized-list"]')).toBeNull()

    fireEvent.change(input, { target: { value: 'no matching command exists' } })
    await screen.findByText('No commands match')
    expect(list.querySelectorAll('[role="option"]').length).toBe(0)
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() =>
      expect(selectedRow(list)?.getAttribute('data-value')).toBe(commands[400].key)
    )
    expectWindowed(list)
    expect(onRunCommand).not.toHaveBeenCalled()
  })

  it('keeps the project/global separator in the scrollable window and deletes the correct command', async () => {
    const { list, onRunCommand, onDeleteCommand } = await openMenu()
    fireEvent.scroll(list, { target: { scrollTop: 249 * ROW_HEIGHT } })
    await screen.findByRole('button', { name: 'Remove Command 250' })
    expect(list.querySelectorAll('[cmdk-separator]').length).toBe(1)
    expectWindowed(list)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Command 250' }))
    expect(onDeleteCommand).toHaveBeenCalledExactlyOnceWith(commands[250])
    expect(onRunCommand).not.toHaveBeenCalled()
  })
})
