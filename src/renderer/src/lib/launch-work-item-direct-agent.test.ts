import { expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string, vars?: Record<string, string>) =>
    value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars?.[name] ?? '')
}))

import { buildDirectWorkItemAgentStartupPlan } from './launch-work-item-direct-agent'

it('keeps own permission on the direct terminal route with unrelated args and env', () => {
  const result = buildDirectWorkItemAgentStartupPlan({
    agent: 'codex',
    draftContent: 'Fix checks',
    promptDelivery: 'draft',
    launchPlatform: 'linux',
    settings: {
      agentPermissionDefault: 'full-access',
      agentDefaultArgs: { codex: '--search' },
      agentDefaultEnv: { codex: { KEEP: 'value' } }
    },
    sessionOptions: { permissionMode: 'own' }
  })
  expect(result.startupPlan?.launchCommand).not.toContain('bypass')
  expect(result.startupPlan?.launchCommand).toContain("'--search'")
  expect(result.startupPlan?.env).toEqual({ KEEP: 'value' })
})
