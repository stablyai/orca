// @vitest-environment happy-dom
import { rpc, status } from '../agent/launch-menu/new-tab-agent-menu-host-preferences-test-fixture'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { BOTS_CREATE_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const picker: { entries: AgentPickerEntry[]; open?: (open: boolean) => void } = vi.hoisted(() => ({
  entries: []
}))
// Stands in for the user opening the agent picker.
vi.mock('@/components/agent/AgentLaunchPicker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AgentLaunchPicker: (props: {
    entries: AgentPickerEntry[]
    onOpenChange: (open: boolean) => void
  }) => {
    picker.entries = props.entries
    picker.open = props.onOpenChange
    return null
  }
}))
vi.mock('@/lib/bot-catalog', () => ({ createBot: vi.fn(), useHostBots: () => [] }))

import { NewBotDialog } from './NewBotDialog'

const codexModels = (): string[] => {
  const catalog = picker.entries.find((entry) => entry.agent === 'codex')?.catalog
  return catalog && catalog.origin !== 'unknown' ? catalog.models.map((model) => model.id) : []
}

it("lists the picked computer's Codex models, and the new computer's after switching", async () => {
  // Paired servers that run chats and can take a new bot.
  const bots = (runtimeId: string): RuntimeEnvironmentStatus => {
    const entry = status(runtimeId)
    return entry.status
      ? {
          ...entry,
          status: {
            ...entry.status,
            capabilities: [...(entry.status.capabilities ?? []), BOTS_CREATE_RUNTIME_CAPABILITY]
          }
        }
      : entry
  }
  useAppStore.setState({
    runtimeEnvironments: [
      publicRuntimeEnvironment({ id: 'alpha' }),
      publicRuntimeEnvironment({ id: 'beta' })
    ],
    runtimeStatusByEnvironmentId: new Map([
      ['alpha', bots('runtime-1')],
      ['beta', bots('runtime-2')]
    ])
  })
  // Each paired server discovered its own Codex model; nothing else lists one.
  const hostModels: Record<string, string> = { alpha: 'gpt-6.2-sol', beta: 'gpt-6.2-astra' }
  const answer = rpc.call.getMockImplementation()
  rpc.call.mockImplementation(
    async (
      target: { kind: string; environmentId?: string },
      method: string,
      params: { agent?: string }
    ) => {
      if (method !== 'agentSession.modelCatalog') {
        return answer?.(target, method, params)
      }
      const id = params.agent === 'codex' ? hostModels[target.environmentId ?? ''] : undefined
      return id
        ? {
            origin: 'probe',
            fetchedAt: 1,
            models: [{ id, label: id, isDefault: true, efforts: [] }]
          }
        : { origin: 'unknown' }
    }
  )
  render(
    <TooltipProvider>
      <NewBotDialog
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
        initialAgent="codex"
        offerHostId="runtime:alpha"
      />
    </TooltipProvider>
  )
  act(() => picker.open?.(true))
  await waitFor(() => expect(codexModels()).toEqual(['gpt-6.2-sol']))

  const computer = screen.getByRole('combobox', { name: 'Computer' })
  fireEvent.focus(computer)
  fireEvent.click(screen.getByRole('option', { name: /beta/ }))
  act(() => picker.open?.(true))
  await waitFor(() => expect(codexModels()).toEqual(['gpt-6.2-astra']))
})
