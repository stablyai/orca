import { describe, expect, it, vi } from 'vitest'
import { createNativeChatReviewMenu } from './native-chat-review-menu'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionHostCommand
} from '../../agent-session/view/structured-agent-session-composer'
import { queuedMessageEditAcceptsText } from '../../queued-message-edit-command'

it.each(['claude', 'opencode', 'codex'])(
  'leaves unadvertised review and stop as text for %s',
  async (agent) => {
    const controller = {
      agent,
      snapshot: [],
      conversationCommands: [],
      setOption: vi.fn(),
      invokeAction: vi.fn()
    }
    for (const text of ['/review', '/review check security', '/stop']) {
      expect(isStructuredAgentSessionHostCommand(text, false, agent, [], [], false)).toBe(false)
      expect(await dispatchStructuredAgentSessionComposerCommand(text, controller)).toEqual({
        handled: false,
        accepted: false,
        error: null
      })
      expect(queuedMessageEditAcceptsText(text, agent, undefined, false, false, [], false)).toBe(
        true
      )
    }
  }
)

it('routes review instructions and immediate cleanup only when the session advertises them', async () => {
  const run = vi.fn(async () => ({ accepted: true, error: null }))
  const clean = vi.fn(async () => true)
  const controller = {
    agent: 'codex',
    snapshot: [],
    conversationCommands: ['review'] as const,
    setOption: vi.fn(),
    invokeAction: vi.fn(),
    runConversationCommand: run,
    cleanBackgroundTerminals: true,
    cleanBackgroundTerminalsCommand: clean
  }
  expect(
    await dispatchStructuredAgentSessionComposerCommand('/review check correctness', controller)
  ).toMatchObject({ handled: true, accepted: true })
  expect(run).toHaveBeenCalledWith('review', 'check correctness', undefined, { type: 'custom' })
  expect(await dispatchStructuredAgentSessionComposerCommand('/stop', controller)).toMatchObject({
    handled: true,
    accepted: true
  })
  expect(clean).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledOnce()
  expect(await dispatchStructuredAgentSessionComposerCommand('/review', controller)).toMatchObject({
    handled: true
  })
  expect(controller.invokeAction.mock.calls[0]?.[0]).toBe('review')
  expect(
    queuedMessageEditAcceptsText('/review', 'codex', undefined, false, false, ['review'], true)
  ).toBe(false)
})

describe('review target navigation', () => {
  it.each([1000, 10000])(
    'loads %i local branches once per visit and submits the selected target',
    async (count) => {
      const branches = vi.fn(async () => Array.from({ length: count }, (_, i) => `topic-${i}`))
      const commits = vi.fn(async () => [{ id: 'abc123', subject: 'Change sum' }])
      const run = vi.fn(async () => ({ accepted: true, error: null }))
      const menu = createNativeChatReviewMenu({
        hasGit: true,
        branches,
        commits,
        run,
        onError: vi.fn()
      })
      await menu.select('baseBranch')
      expect(branches).toHaveBeenCalledTimes(1)
      expect(commits).not.toHaveBeenCalled()
      expect(menu.getSnapshot().choices).toHaveLength(count)
      expect(await menu.select('topic-999')).toBe(true)
      expect(run).toHaveBeenCalledWith({ type: 'baseBranch', branch: 'topic-999' }, undefined)
      menu.back()
      await menu.select('commit')
      expect(commits).toHaveBeenCalledTimes(1)
      await menu.select('abc123')
      expect(run).toHaveBeenLastCalledWith(
        { type: 'commit', sha: 'abc123', title: 'Change sum' },
        undefined
      )
    }
  )
  it('keeps custom instructions available without git and discards a closed child result', async () => {
    const branches = vi.fn(async () => [])
    const run = vi.fn(async () => ({ accepted: true, error: null }))
    const menu = createNativeChatReviewMenu({
      hasGit: false,
      branches,
      commits: vi.fn(),
      run,
      onError: vi.fn()
    })
    expect(menu.getSnapshot().choices.map((choice) => choice.value)).toEqual(['custom'])
    await menu.select('custom')
    expect(await menu.submit('  Check the API contract  ')).toBe(true)
    expect(run).toHaveBeenCalledWith({ type: 'custom' }, 'Check the API contract')
    expect(branches).not.toHaveBeenCalled()
  })
})
