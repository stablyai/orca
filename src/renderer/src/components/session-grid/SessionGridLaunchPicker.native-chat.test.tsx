// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentLaunchSurface } from '@/lib/launch-agent-in-new-tab'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { SessionGridLaunchTargetList } from './SessionGridLaunchPicker'

const harness = vi.hoisted(() => ({
  launch: vi.fn<
    () => {
      surface: AgentLaunchSurface
      structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
    }
  >(),
  reveal: vi.fn<(...args: unknown[]) => unknown>(() => ({})),
  activateChat: vi.fn(),
  mount: vi.fn(),
  done: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof harness) => unknown) => selector(harness)
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['codex'] })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  useStructuredAgentLaunchStatus: () => 'idle'
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: harness.launch }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: harness.reveal }))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: harness.activateChat
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: harness.mount
}))
vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  CommandSeparator: () => <hr />,
  CommandShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

beforeEach(() => {
  vi.clearAllMocks()
  harness.reveal.mockReturnValue({})
})
afterEach(cleanup)

function launchChat() {
  let settle!: (result: StructuredAgentLaunchSettlement) => void
  const structuredSettlement = new Promise<StructuredAgentLaunchSettlement>((resolve) => {
    settle = resolve
  })
  harness.launch.mockReturnValue({
    surface: { kind: 'local-agent-session', tabId: 'chat-tab', sessionId: 'new-chat' },
    structuredSettlement
  })
  render(
    <SessionGridLaunchTargetList
      entry={{
        worktreeId: 'folder:docs',
        worktreeName: 'Docs',
        repoId: 'docs',
        repoName: 'Docs',
        path: '/docs',
        label: 'Docs',
        hostKind: 'local',
        executionHostId: 'local'
      }}
      onDone={harness.done}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
  return async (result: StructuredAgentLaunchSettlement) => {
    await act(async () => {
      settle(result)
      await structuredSettlement
    })
  }
}

it('waits for native chat creation, then reveals its workspace and closes the picker', async () => {
  const settle = launchChat()
  expect(harness.done).not.toHaveBeenCalled()
  expect(harness.reveal).not.toHaveBeenCalled()
  await settle({ kind: 'structured', sessionId: 'new-chat' })
  expect(harness.reveal).toHaveBeenCalledWith('folder:docs', {
    executionHostId: 'local',
    providesInitialSurface: true
  })
  expect(harness.activateChat).toHaveBeenCalledWith({
    worktreeId: 'folder:docs',
    sessionId: 'new-chat'
  })
  expect(harness.done).toHaveBeenCalledOnce()
  expect(harness.mount).not.toHaveBeenCalled()
})

it.each([
  { kind: 'cancelled', sessionId: 'new-chat' },
  { kind: 'failed', error: new Error('Refused') }
] as const)('does not report a successful launch for $kind', async (result) => {
  const settle = launchChat()
  await settle(result)
  expect(harness.done).not.toHaveBeenCalled()
  expect(harness.reveal).not.toHaveBeenCalled()
  expect(harness.mount).not.toHaveBeenCalled()
})

it('reveals the workspace when creation is awaiting visibility recovery', async () => {
  const settle = launchChat()
  await settle({ kind: 'visibility-unknown', sessionId: 'pending-chat' })
  expect(harness.activateChat).toHaveBeenCalledWith({
    worktreeId: 'folder:docs',
    sessionId: 'pending-chat'
  })
  expect(harness.done).toHaveBeenCalledOnce()
})

it('keeps the picker open when the workspace cannot be revealed', async () => {
  const settle = launchChat()
  harness.reveal.mockReturnValue(false)
  await settle({ kind: 'structured', sessionId: 'new-chat' })
  expect(harness.activateChat).not.toHaveBeenCalled()
  expect(harness.done).not.toHaveBeenCalled()
})
