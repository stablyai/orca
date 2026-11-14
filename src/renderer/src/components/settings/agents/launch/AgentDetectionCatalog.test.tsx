// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { TooltipProvider } from '../../../ui/tooltip'

const claude: AgentCatalogEntry = {
  id: 'claude',
  label: 'Claude',
  cmd: 'claude',
  homepageUrl: 'https://claude.ai'
}
const codex: AgentCatalogEntry = {
  id: 'codex',
  label: 'Codex',
  cmd: 'codex',
  homepageUrl: 'https://openai.com'
}
function row(onSaveOverride: AgentCatalogRowProps['onSaveOverride']): AgentCatalogRowProps {
  return {
    agentId: 'claude',
    label: 'Claude',
    homepageUrl: 'https://claude.ai',
    defaultCmd: 'claude',
    defaultArgs: '',
    defaultEnv: {},
    isDetected: false,
    isEnabled: true,
    defaultMark: null,
    isSavedDefault: false,
    cmdOverride: undefined,
    argsOverride: '',
    envOverride: {},
    onSetDefault: vi.fn(),
    onSetEnabled: vi.fn(),
    onSaveOverride,
    onSaveArgs: vi.fn(),
    onSaveEnv: vi.fn()
  }
}
function catalog(installed: boolean, save: AgentCatalogRowProps['onSaveOverride']) {
  return (
    <StrictMode>
      <TooltipProvider>
        <AgentDetectionCatalog
          detectedAgents={installed ? [claude, codex] : [codex]}
          undetectedAgents={installed ? [] : [claude]}
          detectionPending={false}
          detectionFailed={false}
          isRefreshing={false}
          activeServerEnvironmentId={null}
          activeServerName={null}
          onRefresh={vi.fn()}
          getRowProps={(agent) => ({
            ...row(agent.id === 'claude' ? save : () => {}),
            agentId: agent.id,
            label: agent.label,
            defaultCmd: agent.cmd
          })}
        />
      </TooltipProvider>
    </StrictMode>
  )
}
afterEach(cleanup)

it('retains a focused unsaved command and selection across asynchronous membership changes', async () => {
  const save = vi.fn()
  const view = render(catalog(false, save))
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
  const input = screen.getByDisplayValue('claude') as HTMLInputElement
  input.focus()
  fireEvent.change(input, { target: { value: '/custom/unsaved-claude' } })
  input.setSelectionRange(3, 9, 'backward')
  await act(async () => {
    await Promise.resolve()
    view.rerender(catalog(true, save))
  })
  const installed = screen.getByRole('region', { name: 'Installed agents' })
  expect(installed.contains(input)).toBe(true)
  expect(screen.getByDisplayValue('/custom/unsaved-claude')).toBe(input)
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
    3,
    9,
    'backward'
  ])
  expect(save).not.toHaveBeenCalled()
  view.rerender(catalog(false, save))
  expect(screen.getByRole('region', { name: 'Agents available to install' }).contains(input)).toBe(
    true
  )
  expect(document.activeElement).toBe(input)
  expect(save).not.toHaveBeenCalled()
  view.unmount()
  expect(input.isConnected).toBe(false)
})

it('keeps a pending save attached to the same editor when membership changes', async () => {
  let finish!: () => void
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const view = render(catalog(false, save))
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
  const input = screen.getByDisplayValue('claude') as HTMLInputElement
  fireEvent.change(input, { target: { value: '/custom/claude' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input.readOnly).toBe(true))
  view.rerender(catalog(true, save))
  expect(screen.getByDisplayValue('/custom/claude')).toBe(input)
  expect(input.readOnly).toBe(true)
  await act(async () => finish())
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(save).toHaveBeenCalledWith('/custom/claude')
})
