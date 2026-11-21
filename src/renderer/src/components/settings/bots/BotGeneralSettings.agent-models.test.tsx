// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { Bot } from '../../../../../shared/bot-types'
import type { NewTabAgentMenuModel } from '../../agent/launch-menu/new-tab-agent-menu-model'

const mocks = vi.hoisted(() => {
  const picker: { entries: AgentPickerEntry[]; open?: (open: boolean) => void } = { entries: [] }
  return { callStructuredAgentSession: vi.fn(), picker }
})

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: (...args: unknown[]) => mocks.callStructuredAgentSession(...args)
}))
vi.mock('@/runtime/native-chat/model-catalogs/model-menu-invalidation', () => ({
  modelMenuRequestContext: () => 'ctx',
  subscribeModelMenuInvalidation: () => () => {}
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('@/components/bots/use-bot-agent-choices', () => {
  const model: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [{ agent: 'omp', kind: 'chat', executionHostId: 'local' }],
    detection: {
      detectedIds: ['omp'],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => ['omp']
    },
    pickerContext: {
      workspace: { kind: 'folder', executionHostId: 'local' },
      executionHostId: 'local',
      settings: null,
      key: 'bot-menu:local'
    }
  }
  return { useBotAgentMenu: () => ({ model, choices: ['omp'] }) }
})
// Stands in for the user opening the agent picker.
vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: (props: {
    entries: AgentPickerEntry[]
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.picker.entries = props.entries
    mocks.picker.open = props.onOpenChange
    return null
  }
}))

import { BotAgentSettings } from './BotGeneralSettings'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ompBot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'omp',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
} satisfies Bot

// OMP lists its models only in a chat's folder; asked without one, the host stops the listing.
it("lists the bot's models in the bot's own folder", async () => {
  mocks.callStructuredAgentSession.mockImplementation(
    async (_target: unknown, _method: string, params: { worktree?: string }) =>
      params.worktree === 'id:folder:fw-1'
        ? {
            origin: 'probe',
            models: [{ id: 'anthropic/opus', label: 'Opus', isDefault: true, efforts: [] }]
          }
        : { origin: 'unknown' }
  )
  render(<BotAgentSettings bot={ompBot} update={async () => null} />)

  act(() => mocks.picker.open?.(true))

  await waitFor(() => {
    const catalog = mocks.picker.entries[0]?.catalog
    expect(catalog?.origin === 'probe' ? catalog.models.map((model) => model.id) : []).toEqual([
      'anthropic/opus'
    ])
  })
})
