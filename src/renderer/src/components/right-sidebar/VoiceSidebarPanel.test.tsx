// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import VoiceSidebarPanel from './VoiceSidebarPanel'
import { useVoiceSidebarSessions } from '@/store/voice-sidebar-state'

const fake = vi.hoisted(() => ({
  create: vi.fn(),
  workspace: {
    worktreeId: 'folder',
    executionHostId: 'local',
    key: 'local-folder',
    entry: undefined,
    tab: { id: 'existing-chat', entityId: 'session', label: 'Existing conversation' }
  }
}))
vi.mock('@/store/voice-sidebar-session', () => ({
  createVoiceSidebarSession: fake.create,
  useVoiceSidebarWorkspace: () => fake.workspace
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/components/native-chat/use-native-chat-store-appearance-style', () => ({
  useNativeChatStoreAppearanceStyle: () => ({})
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('connects to the selected chat without creating one and releases its portal when closed', () => {
  const { rerender, unmount } = render(<VoiceSidebarPanel />)
  expect(fake.create).not.toHaveBeenCalled()
  expect(screen.getByText('Existing conversation')).toBeInTheDocument()
  expect(useVoiceSidebarSessions.getState().portal?.tabId).toBe('existing-chat')
  fake.workspace.tab = {
    id: 'second-chat',
    entityId: 'second-session',
    label: 'Second conversation'
  }
  rerender(<VoiceSidebarPanel />)
  expect(useVoiceSidebarSessions.getState().portal?.tabId).toBe('second-chat')
  expect(fake.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  expect(fake.create).toHaveBeenCalledExactlyOnceWith('local-folder', 'folder', 'local')
  unmount()
  expect(useVoiceSidebarSessions.getState().portal).toBeNull()
})
