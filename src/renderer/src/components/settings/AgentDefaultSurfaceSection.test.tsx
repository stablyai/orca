// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import { saveNativeChatProviderChoice } from './native-chat-provider-choice'
import { AgentDefaultSurfaceSection } from './AgentDefaultSurfaceSection'

vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'grok', 'opencode']
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), dismiss: vi.fn(), error: vi.fn() } }))

let persisted: GlobalSettings
const settingsSet = vi.fn(async (updates: Partial<GlobalSettings>) => {
  persisted = { ...persisted, ...updates }
  return persisted
})

function Section(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  return settings ? <AgentDefaultSurfaceSection settings={settings} /> : null
}

function renderSection(settings: Partial<GlobalSettings>): void {
  persisted = createGlobalSettingsFixture(settings)
  useAppStore.setState({ settings: persisted })
  render(<Section />)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  settingsSet.mockClear()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { set: settingsSet } }
  })
})
afterEach(cleanup)

describe('Open agents as', () => {
  it('sets only the default, names agents set to the other surface, and Set all makes them follow', async () => {
    renderSection({
      agentDefaultSurface: 'terminal',
      // Grok already matches Chat; OpenCode is off, so its row offers no choice.
      nativeChatProviders: { claude: false, codex: false, grok: true, opencode: false },
      disabledTuiAgents: ['opencode']
    })
    expect(screen.getByRole('radio', { name: /^Terminal/ })).toHaveProperty('checked', true)

    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(settingsSet).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
    const [title, options] = vi.mocked(toast.success).mock.calls[0]
    expect(title).toBe('Agents now open as chats')
    expect(options?.description).toBe('Claude and Codex stay in the terminal, as you set.')
    const action = options?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) {
      throw new Error('Missing reset action')
    }
    expect(action.label).toBe('Set all to Chat')

    fireEvent.click(
      render(<button onClick={action.onClick}>Reset choices</button>).getByRole('button', {
        name: 'Reset choices'
      })
    )
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2))
    expect(settingsSet).toHaveBeenLastCalledWith({
      nativeChatProviders: { grok: true, opencode: false }
    })
  })

  it('shows no toast when every agent’s own choice already matches the new default', async () => {
    renderSection({ agentDefaultSurface: 'chat', nativeChatProviders: { claude: false } })
    fireEvent.click(screen.getByRole('radio', { name: /^Terminal/ }))
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'terminal' })
    )
    await Promise.resolve()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('acknowledged default writes', () => {
  it('reports a rejected tile save once, preserves the choice, and accepts its successor', async () => {
    renderSection({ agentDefaultSurface: 'terminal' })
    settingsSet.mockRejectedValueOnce(new Error('disk unavailable'))
    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'Agent settings could not be saved. Try again.'
      )
    )
    expect(persisted.agentDefaultSurface).toBe('terminal')
    expect(screen.getByRole('radio', { name: /^Terminal/ })).toHaveProperty('checked', true)
    expect(toast.success).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /^Chat/ })).toHaveProperty('checked', true)
    )
    expect(persisted.agentDefaultSurface).toBe('chat')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('disables both tiles with pending feedback until the checked write settles', async () => {
    renderSection({ agentDefaultSurface: 'terminal' })
    let release: () => void = () => {}
    settingsSet.mockImplementationOnce(async (updates) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      persisted = { ...persisted, ...updates }
      return persisted
    })
    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBe('true')
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveProperty('disabled', true)
    }
    expect(screen.getByRole('radio', { name: /^Terminal/ })).toHaveProperty('checked', true)
    await act(async () => release())
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /^Chat/ })).toHaveProperty('checked', true)
    )
    expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBe('false')
    fireEvent.click(screen.getByRole('radio', { name: /^Terminal/ }))
    await waitFor(() => expect(persisted.agentDefaultSurface).toBe('terminal'))
  })

  it('reports reset rejection once without losing overrides and continues the shared per-agent queue', async () => {
    renderSection({
      agentDefaultSurface: 'terminal',
      nativeChatProviders: { claude: false, codex: false, custom: true }
    })
    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    settingsSet.mockRejectedValueOnce(new Error('disk unavailable'))
    const action = vi.mocked(toast.success).mock.calls[0][1]?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) {
      throw new Error('Missing reset action')
    }
    fireEvent.click(
      render(<button onClick={action.onClick}>Reset choices</button>).getByRole('button', {
        name: 'Reset choices'
      })
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(persisted.nativeChatProviders).toEqual({ claude: false, codex: false, custom: true })
    await act(async () =>
      saveNativeChatProviderChoice({
        agent: 'codex',
        on: true,
        fallbackSettings: persisted,
        updateSettings: useAppStore.getState().updateSettingsOrThrow
      })
    )
    expect(persisted.nativeChatProviders).toEqual({ claude: false, custom: true })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})

describe('notice and reset work bounds', () => {
  it.each([20, 200])(
    'scans %i saved choices linearly with one write per user action',
    async (count) => {
      let reads = 0
      const choices: Record<string, boolean> = {}
      for (let index = 0; index < count; index++) {
        Object.defineProperty(choices, `custom-${index}`, {
          enumerable: true,
          get: () => {
            reads++
            return true
          }
        })
      }
      choices.claude = false
      renderSection({ agentDefaultSurface: 'terminal', nativeChatProviders: choices })
      reads = 0
      fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
      expect(reads).toBe(count)
      expect(settingsSet).toHaveBeenCalledTimes(1)
      reads = 0
      const action = vi.mocked(toast.success).mock.calls[0][1]?.action
      if (!action || typeof action !== 'object' || !('onClick' in action)) {
        throw new Error('Missing reset action')
      }
      fireEvent.click(
        render(<button onClick={action.onClick}>Reset choices</button>).getByRole('button', {
          name: 'Reset choices'
        })
      )
      await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2))
      expect(reads).toBe(count)
      expect(persisted.nativeChatProviders).not.toHaveProperty('claude')
      expect(Object.keys(persisted.nativeChatProviders ?? {})).toHaveLength(count)
    }
  )
})
