// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentLaunchProfile } from '../../../../shared/agent-launch-profile'
import { AgentProfileMenuItem } from './AgentProfileMenuItem'
const status = vi.hoisted(() =>
  vi.fn((_worktree: string, _agent: string, profile: AgentLaunchProfile) =>
    profile.id === 'a' ? 'pending' : 'idle'
  )
)
vi.mock('@/lib/structured-agent-session-launch-status', () => ({
  useStructuredAgentLaunchStatus: status
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>
}))
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, disabled }: { children: React.ReactNode; disabled: boolean }) => (
    <button disabled={disabled}>{children}</button>
  )
}))
afterEach(cleanup)
it.each(['claude', 'codex'] as const)('%s profile A pending does not disable B', (agent) => {
  const a: AgentLaunchProfile = {
    id: 'a',
    name: 'Profile A',
    agent,
    hostId: 'local',
    executable: `/bin/${agent}`,
    binding: { kind: 'managed', accountId: 'a' }
  }
  const b: AgentLaunchProfile = {
    ...a,
    id: 'b',
    name: 'Profile B',
    binding: { kind: 'external', home: '/profiles/b' }
  }
  render(
    <>
      <AgentProfileMenuItem
        profile={a}
        worktreeId="folder:one"
        disabled={false}
        onSelect={vi.fn()}
        label="a@example.test"
      />
      <AgentProfileMenuItem
        profile={b}
        worktreeId="folder:one"
        disabled={false}
        onSelect={vi.fn()}
      />
    </>
  )
  expect(screen.getByRole('button', { name: /Profile A/ }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: /Profile B/ }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByText('Unverified configuration')).toBeTruthy()
  expect(status).toHaveBeenCalledWith('folder:one', agent, a)
  expect(status).toHaveBeenCalledWith('folder:one', agent, b)
})
