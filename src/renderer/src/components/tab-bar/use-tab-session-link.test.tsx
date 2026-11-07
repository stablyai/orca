// @vitest-environment happy-dom
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { SessionLinkParticipant, SESSION_LINK_CAPABILITY } from '../../../../shared/session-link'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useTabSessionLink } from './use-tab-session-link'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  structuredAgentSessionHostSupports: async () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
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
it('keeps the selected pair after the context menu closes and submits only after confirmation', async () => {
  const source = tab('source'),
    partner = tab('partner')
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
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Slice 1b' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create link and introduce agents' }))
  await waitFor(() =>
    expect(
      rpc.mock.calls.find(([, method]) => method === 'orchestration.linkCreate')?.[2]
    ).toMatchObject({
      sessionId: 'codex-source',
      partnerSessionId: 'codex-partner',
      story: 'Slice 1b',
      role: 'implementer'
    })
  )
})
