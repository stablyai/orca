// @vitest-environment happy-dom
import type * as SessionHostCapabilityModule from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { SessionLinkParticipant, SESSION_LINK_CAPABILITY } from '../../../../shared/session-link'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useTabSessionLink } from './use-tab-session-link'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))
vi.mock(
  '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SessionHostCapabilityModule>()),
    useStructuredAgentSessionHostCapabilityState: () => 'supported'
  })
)
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: async () => true
}))
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({ getNamingSnapshot: () => new Map() })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_: string, fallback: string) => fallback
}))
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  rpc.mockReset()
})

function Harness({ menuOpen }: { menuOpen: boolean }) {
  const link = useTabSessionLink('workspace', 'tab-partner', menuOpen)
  return (
    <>
      {link.onOpen ? <button onClick={link.onOpen}>Menu action</button> : null}
      {link.dialog}
    </>
  )
}
const participant = (id: string) =>
  SessionLinkParticipant.parse({
    sessionId: `codex-${id}`,
    conversationId: `codex-${id}`,
    name: 'codex',
    agent: 'codex',
    role: 'implementer',
    workspaceId: 'workspace',
    directory: '/projects/registry',
    branch: 'main',
    task: '',
    context: ''
  })
const tab = (id: string): Tab => ({
  id: `tab-${id}`,
  entityId: `codex-${id}`,
  worktreeId: 'workspace',
  groupId: 'group',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  executionHostId: 'local',
  label: id,
  customLabel: `${id} chat`,
  color: null,
  sortOrder: 0,
  createdAt: 0
})
it.each(['local', 'runtime:macbook'] as const)(
  'keeps the selected pair on %s after the menu closes and submits to its owner',
  async (host) => {
    const source = { ...tab('source'), executionHostId: host },
      partner = { ...tab('partner'), executionHostId: host }
    setLocalRuntimeCapabilitiesForTests([SESSION_LINK_CAPABILITY])
    useAppStore.setState({
      activeWorktreeId: 'workspace',
      unifiedTabsByWorktree: { workspace: [source, partner] },
      activeGroupIdByWorktree: { workspace: 'group' },
      groupsByWorktree: {
        workspace: [
          {
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: source.id,
            tabOrder: [source.id, partner.id]
          }
        ]
      }
    })
    rpc.mockImplementation(async (_target, method, fields) => {
      if (method === 'orchestration.linkCandidates') {
        return { source: participant('source'), candidates: [participant('partner')], history: [] }
      }
      if (method === 'orchestration.linkCreate') {
        return {
          link: {
            id: fields.id,
            story: fields.story,
            participants: [participant('source'), participant('partner')],
            state: 'active',
            reason: '',
            version: 1,
            turns: 0,
            messages: 0,
            createdAt: 1,
            updatedAt: 1
          },
          events: []
        }
      }
      return null
    })
    const view = render(<Harness menuOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Menu action' }))
    view.rerender(<Harness menuOpen={false} />)
    expect(await screen.findByText('source chat')).toBeTruthy()
    expect(screen.getByText('partner chat')).toBeTruthy()
    expect(rpc.mock.calls.some(([, method]) => method === 'orchestration.linkCreate')).toBe(false)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Checkout slice 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link and introduce agents' }))
    await waitFor(() =>
      expect(
        rpc.mock.calls.find(([, method]) => method === 'orchestration.linkCreate')?.[2]
      ).toMatchObject({
        sessionId: 'codex-source',
        partnerSessionIds: ['codex-partner'],
        groupSupport: true,
        story: 'Checkout slice 2',
        role: 'implementer'
      })
    )
    expect(
      rpc.mock.calls.every(([target]) =>
        host === 'local'
          ? target.kind === 'local'
          : target.kind === 'environment' && target.environmentId === 'macbook'
      )
    ).toBe(true)
  }
)
