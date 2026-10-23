// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatToolResultBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolOutput } from './NativeChatToolOutput'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  owner: { target: { kind: 'local' }, sessionId: 'session', worktreeId: 'workspace' }
}))
vi.mock('./native-chat-visual-owner', () => ({ useNativeChatVisualOwner: () => mocks.owner }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionItemDetail: async () => true,
  readStructuredAgentSessionItem: mocks.read
}))
const container = document.createElement('div')
const root = createRoot(container)
afterEach(() => {
  act(() => root.unmount())
  mocks.read.mockReset()
})

it('fences same-head live revisions and late replies, and keeps null/partial results truthful', async () => {
  const body: NativeChatToolResultBlock = {
    type: 'tool-result',
    output: 'x'.repeat(16_384),
    fullOutputItemId: 'call'
  }
  const response = (text: string, truncated = false): AgentJournalRenderItem => ({
    itemId: 'call',
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'tool-call',
      name: 'bash',
      input: null,
      state: 'running',
      output: { head: text, byteLength: 100_000, digest: 'd', truncated }
    }
  })
  const render = (block: NativeChatToolResultBlock) =>
    act(() => root.render(<NativeChatToolOutput body={block} />))
  const click = async () => {
    await act(async () => container.querySelector('button')?.click())
  }
  render(body)
  mocks.read.mockResolvedValueOnce(response('OLD TAIL'))
  await click()
  expect(container.textContent).toContain('OLD TAIL')
  render({ ...body })
  expect(container.textContent).not.toContain('OLD TAIL')
  expect(container.querySelector('button')).not.toBeNull()
  const pending = Promise.withResolvers<AgentJournalRenderItem>()
  mocks.read.mockReturnValueOnce(pending.promise)
  await click()
  render({ ...body })
  await act(async () => pending.resolve(response('STALE TAIL')))
  expect(container.textContent).not.toContain('STALE TAIL')
  mocks.read.mockResolvedValueOnce(null)
  await click()
  expect(container.textContent).toContain("Couldn't load the full output.")
  expect(container.querySelector('button')).not.toBeNull()
  mocks.read.mockResolvedValueOnce(response('PARTIAL', true))
  await click()
  expect(container.textContent).toContain('Showing')
  expect(container.textContent).toContain('PARTIAL')
})
