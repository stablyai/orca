import { expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: vi.fn()
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn()
}))

vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle: vi.fn()
}))

it('does not read the Zustand store while importing completion notifications', async () => {
  await expect(import('./agent-hook-completion-notifications')).resolves.toBeDefined()
})
