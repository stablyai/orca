// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import { NativeChatSideChatMenuItem } from './NativeChatSideChatMenuItem'

type MenuState = { unifiedTabsByWorktree: { workspace: { id: string }[] } }

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => true
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
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  )
}))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it.each(['refused', 'rejected'] as const)(
  'reports a %s side-chat menu action visibly',
  async (outcome) => {
    if (outcome === 'refused') {
      mocks.open.mockResolvedValue(false)
    } else {
      mocks.open.mockRejectedValue(new Error('private transport details'))
    }
    const onComplete = vi.fn()
    render(
      <NativeChatSideChatMenuItem
        tab={{ id: 'parent-tab', worktreeId: 'workspace' }}
        nativeChat={{ sessionId: 'parent-session', agent: 'codex' }}
        onComplete={onComplete}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use main chat permissions' }))
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
    render(
      <NativeChatSideChatMenuItem
        tab={{ id: 'parent-tab', worktreeId: 'workspace' }}
        nativeChat={{ sessionId: 'parent-session', agent: 'codex' }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
        '',
        [],
        label === 'Read only' ? 'read-only' : 'inherit'
      )
    )
  }
)
