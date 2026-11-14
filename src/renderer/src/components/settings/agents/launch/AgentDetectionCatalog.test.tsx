// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { TooltipProvider } from '../../../ui/tooltip'
import { cancelSettingsListReveal } from '../../section-layout/settings-list-scroll'

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
  const input = screen.getByDisplayValue<HTMLInputElement>('claude')
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
  const input = screen.getByDisplayValue<HTMLInputElement>('claude')
  fireEvent.change(input, { target: { value: '/custom/claude' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input.readOnly).toBe(true))
  view.rerender(catalog(true, save))
  expect(screen.getByDisplayValue('/custom/claude')).toBe(input)
  expect(screen.getByRole('region', { name: 'Installed agents' }).contains(input)).toBe(true)
  expect(input.readOnly).toBe(true)
  await act(async () => finish())
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(save).toHaveBeenCalledWith('/custom/claude')
})

it.each([
  { initial: undefined, later: '/later/claude', expected: 'false' },
  { initial: '/seed/claude', later: undefined, expected: 'true' }
])(
  'latches an asynchronously arriving row before later command settings change: $expected',
  async ({ initial, later, expected }) => {
    const pane = (
      stage: 'pending' | 'installed' | 'available',
      cmdOverride: string | undefined
    ) => (
      <StrictMode>
        <TooltipProvider>
          <AgentDetectionCatalog
            detectedAgents={stage === 'installed' ? [claude] : []}
            undetectedAgents={stage === 'available' ? [claude] : []}
            detectionPending={stage === 'pending'}
            detectionFailed={false}
            isRefreshing={false}
            activeServerEnvironmentId={null}
            activeServerName={null}
            onRefresh={vi.fn()}
            getRowProps={() => ({ ...row(vi.fn()), cmdOverride })}
          />
        </TooltipProvider>
      </StrictMode>
    )
    const view = render(pane('pending', initial))
    await act(async () => {
      await Promise.resolve()
      view.rerender(pane('installed', initial))
    })
    expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-expanded')).toBe(
      expected
    )
    view.rerender(pane('installed', later))
    expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-expanded')).toBe(
      expected
    )
    view.rerender(pane('available', later))
    const available = screen.getByRole('region', { name: 'Agents available to install' })
    expect(available.contains(screen.getByRole('button', { name: 'Claude' }))).toBe(true)
    expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-expanded')).toBe(
      expected
    )
  }
)

it('reveals a focused moved editor while letting newer focus and navigation take precedence', async () => {
  const view = render(catalog(false, vi.fn()))
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
  const input = screen.getByDisplayValue<HTMLInputElement>('claude')
  input.focus()
  const destination = screen.getByRole('region', { name: 'Installed agents' })
  const source = screen.getByRole('region', { name: 'Agents available to install' })
  source.scrollTop = 20
  view.container.scrollTop = 40
  vi.spyOn(destination, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 100, 500, 200)
  )
  vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 800 - destination.scrollTop, 100, 20)
  )
  view.rerender(catalog(true, vi.fn()))
  await waitFor(() => expect(destination.scrollTop).toBe(544))
  expect(source.scrollTop).toBe(20)
  expect(view.container.scrollTop).toBe(40)
  expect(document.activeElement).toBe(input)

  const outside = document.createElement('button')
  view.container.append(outside)
  const settleReveal = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

  outside.focus()
  view.rerender(catalog(false, vi.fn()))
  destination.scrollTop = 0
  view.rerender(catalog(true, vi.fn()))
  await settleReveal()
  expect(destination.scrollTop).toBe(0)
  expect(document.activeElement).toBe(outside)

  view.rerender(catalog(false, vi.fn()))
  input.focus()
  view.rerender(catalog(true, vi.fn()))
  outside.focus()
  await settleReveal()
  expect(destination.scrollTop).toBe(0)
  expect(document.activeElement).toBe(outside)

  view.rerender(catalog(false, vi.fn()))
  input.focus()
  view.rerender(catalog(true, vi.fn()))
  cancelSettingsListReveal()
  await settleReveal()
  expect(destination.scrollTop).toBe(0)
  expect(document.activeElement).toBe(input)
})
