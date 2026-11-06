// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { NativeChatSideChatMenuItem } from './NativeChatSideChatMenuItem'
import { AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'

type MenuState = { unifiedTabsByWorktree: { workspace: { id: string }[] } }

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readOnlySupported: true,
  explicitOptionsSupported: true
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: (_target: unknown, capability: string) =>
    capability === AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY
      ? mocks.explicitOptionsSupported
      : mocks.readOnlySupported
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: MenuState) => unknown) =>
    select({
      unifiedTabsByWorktree: { workspace: [{ id: 'parent-tab' }] }
    })
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerForTab: () => 'local',
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('../native-chat/use-native-chat-side-chat', () => ({
  useNativeChatSideChat: () => mocks.open
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readOnlySupported = true
  mocks.explicitOptionsSupported = true
})
afterEach(cleanup)

async function openSideChatMenu(onComplete?: () => void) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Chat tab</ContextMenuTrigger>
      <ContextMenuContent>
        <NativeChatSideChatMenuItem
          tab={{ id: 'parent-tab', worktreeId: 'workspace' }}
          nativeChat={{ sessionId: 'parent-session', agent: 'codex' }}
          onComplete={onComplete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('Chat tab'), { clientX: 40, clientY: 20 })
  await screen.findByRole('menu')
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New side chat' }), { key: 'ArrowRight' })
  await screen.findByRole('menuitem', { name: 'Read only' })
}

it.each(['refused', 'rejected'] as const)(
  'reports a %s side-chat menu action visibly',
  async (outcome) => {
    if (outcome === 'refused') {
      mocks.open.mockResolvedValue(false)
    } else {
      mocks.open.mockRejectedValue(new Error('private transport details'))
    }
    const onComplete = vi.fn()
    await openSideChatMenu(onComplete)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use main chat permissions' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not open a side chat.')
    )
    expect(onComplete).toHaveBeenCalledOnce()
  }
)

it.each(['Read only', 'Use main chat permissions'] as const)(
  'opens %s with its selected policy',
  async (label) => {
    mocks.open.mockResolvedValue(true)
    await openSideChatMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
        '',
        [],
        label === 'Read only' ? 'read-only' : 'inherit'
      )
    )
  }
)

it.each(['readOnlySupported', 'explicitOptionsSupported'] as const)(
  'keeps read-only unavailable without %s while inherited permissions remain usable',
  async (capability) => {
    mocks[capability] = false
    mocks.open.mockResolvedValue(true)
    await openSideChatMenu()
    const readOnly = screen.getByRole('menuitem', { name: 'Read only' })
    expect(readOnly.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(readOnly)
    expect(mocks.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use main chat permissions' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledExactlyOnceWith('', [], 'inherit'))
  }
)
