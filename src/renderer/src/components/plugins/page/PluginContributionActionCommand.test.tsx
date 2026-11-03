// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { PluginContributionActionCommand } from './PluginContributionActionCommand'

const executePluginCommand = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/plugin-command-execution', () => ({ executePluginCommand }))
vi.mock('sonner', () => ({ toast }))
const closeSettingsPage = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ closeSettingsPage }) } }))

function command(handler: ActivePluginCommand['handler']): ActivePluginCommand {
  return {
    pluginKey: 'acme.tasks',
    pluginName: 'Tasks',
    id: 'open',
    title: 'Open Tasks',
    context: 'global',
    handler,
    keybindings: []
  }
}

afterEach(() => {
  cleanup()
  executePluginCommand.mockReset()
  toast.success.mockClear()
  toast.error.mockClear()
  closeSettingsPage.mockClear()
})

it('runs the command as the palette would and shows what it returned', async () => {
  executePluginCommand.mockResolvedValue('3 tasks open')
  const worker = command({ type: 'worker' })
  render(<PluginContributionActionCommand command={worker} unavailableReason={null} />)

  fireEvent.click(screen.getByRole('button', { name: 'Run Open Tasks' }))
  expect(executePluginCommand).toHaveBeenCalledExactlyOnceWith(worker, 'plugin-palette')
  expect(closeSettingsPage).not.toHaveBeenCalled()
  await vi.waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Ran Open Tasks', { description: '3 tasks open' })
  )
})

it('truncates a long result and falls back to Logs for one it cannot serialize', async () => {
  executePluginCommand.mockResolvedValueOnce({ lines: Array.from({ length: 60 }, () => 'row') })
  render(
    <PluginContributionActionCommand
      command={command({ type: 'worker' })}
      unavailableReason={null}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run Open Tasks' }))
  await vi.waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
  const [, { description }] = toast.success.mock.calls[0]
  expect(description).toHaveLength(201)
  expect(description.endsWith('…')).toBe(true)

  toast.success.mockClear()
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  executePluginCommand.mockResolvedValueOnce(cyclic)
  fireEvent.click(screen.getByRole('button', { name: 'Run Open Tasks' }))
  await vi.waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Ran Open Tasks', {
      description: 'See Logs below'
    })
  )
})

it('reports a failure instead of pretending it ran', async () => {
  executePluginCommand.mockRejectedValue(new Error('worker crashed'))
  render(
    <PluginContributionActionCommand
      command={command({ type: 'built-in', action: 'view.tasks' })}
      unavailableReason={null}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run Open Tasks' }))
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Open Tasks failed', { description: 'worker crashed' })
  )
  expect(toast.success).not.toHaveBeenCalled()
})

it('leaves Settings before running a built-in action, which Settings would disable', async () => {
  executePluginCommand.mockImplementation(() => {
    expect(closeSettingsPage).toHaveBeenCalledOnce()
    return Promise.resolve(undefined)
  })
  render(
    <PluginContributionActionCommand
      command={command({ type: 'built-in', action: 'view.tasks' })}
      unavailableReason={null}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run Open Tasks' }))
  await vi.waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Ran Open Tasks', { description: undefined })
  )
})
