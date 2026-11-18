import { describe, expect, it } from 'vitest'
import { buildWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { ExternalConversationLink } from '../../../../shared/connectors/external-conversation-link'
import { selectBotRowLine, type BotRowLineInput } from './bot-row-activity-line'
import { botRowLineText } from '../../../../shared/bots/bot-row-line'
import { translate } from '@/i18n/i18n'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOME = 'folder:bot-home'

function session(
  sessionId: string,
  fields: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'state' | 'updatedAt'>
): AgentStatusEntry {
  return {
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    worktreeId: HOME,
    agentType: 'claude',
    prompt: 'the ask',
    stateStartedAt: fields.updatedAt,
    stateHistory: [],
    ...fields
  }
}

function link(
  sessionId: string,
  source: ExternalConversationLink['source'],
  fields: Pick<ExternalConversationLink, 'title' | 'place' | 'lastTurn'> = {}
): ExternalConversationLink {
  return {
    source,
    externalId: `T1:${sessionId}`,
    sessionId,
    agent: 'claude',
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    lastTurn: 'conversation',
    ...fields,
    createdAt: NOW - 60 * MIN
  }
}

function line(entries: AgentStatusEntry[], input: Partial<BotRowLineInput> = {}) {
  return selectBotRowLine({
    paused: false,
    // Bot sessions without a tab still get rows, as they do in the sidebar.
    rows: buildWorktreeAgentRows({ tabs: [], entries, now: NOW }),
    chatSessionId: 'chat',
    links: [
      link('slack-thread', 'slack', { place: '#releases' }),
      link('github-thread', 'github'),
      link('linear-thread', 'linear', { title: 'ENG-42 · Fix login' })
    ],
    waits: [],
    now: NOW,
    ...input
  })
}

describe('selectBotRowLine', () => {
  it('says what its own Chat is doing, with no place', () => {
    expect(
      line([
        session('chat', {
          state: 'working',
          updatedAt: NOW - MIN,
          toolName: 'Read',
          toolInput: 'ENG-42 comments'
        })
      ])
    ).toEqual({
      kind: 'activity',
      place: null,
      text: 'Read: ENG-42 comments',
      at: NOW - MIN
    })
  })

  it('names the thread by its kept place when the newest activity is elsewhere', () => {
    const chat = session('chat', {
      state: 'done',
      updatedAt: NOW - 30 * MIN,
      lastAssistantMessage: 'Older'
    })
    expect(
      line([
        chat,
        session('slack-thread', {
          state: 'done',
          updatedAt: NOW - 2 * MIN,
          lastAssistantMessage: 'Cut v1.4.231'
        })
      ])
    ).toMatchObject({
      kind: 'activity',
      place: { source: 'slack', label: '#releases' },
      text: 'Cut v1.4.231'
    })
    // A link from before places were kept: its service's name, or a Linear key from its title.
    expect(
      line([
        chat,
        session('github-thread', {
          state: 'done',
          updatedAt: NOW - 2 * MIN,
          lastAssistantMessage: 'Merged'
        })
      ])
    ).toMatchObject({ place: { source: 'github', label: 'GitHub' } })
    expect(
      line([
        chat,
        session('linear-thread', {
          state: 'done',
          updatedAt: NOW - 2 * MIN,
          lastAssistantMessage: 'Fixed'
        })
      ])
    ).toMatchObject({ place: { source: 'linear', label: 'ENG-42' }, text: 'Fixed' })
  })

  it('names no place when someone in Orca began the thread chat’s latest turn', () => {
    const typed = session('slack-thread', {
      state: 'done',
      updatedAt: NOW - 2 * MIN,
      lastAssistantMessage: 'Done in Orca'
    })
    expect(
      line([typed], {
        links: [link('slack-thread', 'slack', { place: '#releases', lastTurn: 'orca' })]
      })
    ).toMatchObject({ kind: 'activity', place: null, text: 'Done in Orca' })
    // A link from before turns were kept says nothing of its latest one.
    expect(
      line([typed], {
        links: [{ ...link('slack-thread', 'slack', { place: '#releases' }), lastTurn: undefined }]
      })
    ).toMatchObject({ place: null })
  })

  it('leaves out sessions that are neither its Chat nor a thread, such as automation runs', () => {
    expect(
      line([
        session('chat', {
          state: 'done',
          updatedAt: NOW - 30 * MIN,
          lastAssistantMessage: 'Hi'
        }),
        session('run', {
          state: 'done',
          updatedAt: NOW - MIN,
          lastAssistantMessage: 'Run done'
        })
      ])
    ).toMatchObject({ place: null, text: 'Hi' })
  })

  it('puts what needs the owner, then what works, then what it did, before any wait', () => {
    const waits = [{ label: "Nora's reply", by: NOW + 60 * MIN }, { label: 'CI' }]
    const done = session('chat', {
      state: 'done',
      updatedAt: NOW - MIN,
      lastAssistantMessage: 'Merged #12'
    })
    const working = session('slack-thread', {
      state: 'working',
      updatedAt: NOW - 2 * MIN,
      toolName: 'Read'
    })
    const asking = session('github-thread', {
      state: 'waiting',
      updatedAt: NOW - 3 * MIN,
      lastAssistantMessage: 'Ship it?'
    })
    expect(line([done], { waits })).toMatchObject({ kind: 'activity', text: 'Merged #12' })
    expect(line([done, working], { waits })).toMatchObject({ kind: 'activity', text: 'Read' })
    expect(line([done, working, asking], { waits })).toMatchObject({
      kind: 'activity',
      place: { source: 'github', label: 'GitHub' }
    })
  })

  it('puts its workers between its own Chat and threads and what it last did', () => {
    const waits = [{ label: "Nora's reply" }]
    const done = session('chat', {
      state: 'done',
      updatedAt: NOW - MIN,
      lastAssistantMessage: 'Merged #12'
    })
    const working = session('slack-thread', {
      state: 'working',
      updatedAt: NOW - 2 * MIN,
      toolName: 'Read'
    })
    expect(line([], { waits, workers: { permission: 0, working: 2 } })).toEqual({
      kind: 'workingElsewhere',
      count: 2
    })
    expect(line([done], { waits, workers: { permission: 0, working: 2 } })).toEqual({
      kind: 'workingElsewhere',
      count: 2
    })
    expect(line([working], { workers: { permission: 0, working: 2 } })).toMatchObject({
      kind: 'activity',
      text: 'Read'
    })
    expect(line([working], { workers: { permission: 1, working: 2 } })).toEqual({
      kind: 'needYouElsewhere',
      count: 1
    })
  })

  it('counts with the Items tab where its count is read, after paused and an asking chat', () => {
    const asking = session('chat', { state: 'waiting', updatedAt: NOW - MIN })
    expect(line([], { needsYou: 3, workers: { permission: 1, working: 0 } })).toEqual({
      kind: 'needYouElsewhere',
      count: 3
    })
    // The asking chat speaks for itself before any count.
    expect(line([asking], { needsYou: 3 })?.kind).not.toBe('needYouElsewhere')
    expect(line([], { needsYou: 3, paused: true })).toEqual({ kind: 'paused' })
  })

  // As the host lists them (`bots.chats.own`): automation runs are never among them.
  const chats = [
    { title: 'Plan the launch', paneKey: structuredAgentSessionStatusPaneKey('side-chat') }
  ]

  it('says a side chat is replying, by its title, while automation runs only count', () => {
    const run = session('run', { state: 'working', updatedAt: NOW - MIN })
    const replying = session('side-chat', { state: 'working', updatedAt: NOW - 2 * MIN })
    const replyingLine = line([run, replying], { chats })
    expect(replyingLine).toEqual({
      kind: 'replying',
      place: { source: null, label: 'Plan the launch' }
    })
    expect(botRowLineText(replyingLine!, translate, String)).toBe('Replying in Plan the launch')
    expect(line([run], { chats })).toEqual({ kind: 'workingElsewhere', count: 1 })
  })

  it('keeps Home Chat on a tie with a side chat', () => {
    const at = { state: 'done' as const, updatedAt: NOW - MIN }
    expect(
      line(
        [
          session('side-chat', { ...at, lastAssistantMessage: 'Side' }),
          session('chat', { ...at, lastAssistantMessage: 'Home' })
        ],
        { chats }
      )
    ).toMatchObject({ place: null, text: 'Home' })
  })

  it('puts a side chat asking the owner above its Home Chat working', () => {
    const working = session('chat', { state: 'working', updatedAt: NOW - MIN, toolName: 'Read' })
    const asking = session('side-chat', {
      state: 'waiting',
      updatedAt: NOW - 5 * MIN,
      lastAssistantMessage: 'Ship it?'
    })
    expect(line([working, asking], { chats })).toEqual({
      kind: 'activity',
      place: { source: null, label: 'Plan the launch' },
      text: 'Ship it?',
      at: expect.any(Number)
    })
  })

  it('says a question for the owner while another thread is starting', () => {
    const asking = session('chat', {
      state: 'waiting',
      updatedAt: NOW - MIN,
      lastAssistantMessage: 'Ship it?'
    })
    expect(line([asking], { startingSessionIds: new Set(['slack-thread']) })).toMatchObject({
      kind: 'activity',
      text: 'Ship it?'
    })
  })

  it('keeps what it last said over a wait when a newer turn said nothing', () => {
    const said = session('chat', {
      state: 'done',
      updatedAt: NOW - 5 * MIN,
      lastAssistantMessage: 'Merged #12'
    })
    const silent = session('slack-thread', { state: 'done', updatedAt: NOW - MIN, prompt: '' })
    expect(line([said, silent], { waits: [{ label: 'CI' }] })).toMatchObject({
      kind: 'activity',
      text: 'Merged #12'
    })
  })

  it('leaves out a wait whose deadline has passed', () => {
    const live = { label: 'CI' }
    expect(line([], { waits: [{ label: 'Old', by: NOW - MIN }] })).toBeNull()
    expect(line([], { waits: [{ label: 'Old', by: NOW - MIN }, live] })).toEqual({
      kind: 'wait',
      wait: live,
      more: 0
    })
  })

  it('shows a wait only when nothing else says anything, counting several', () => {
    const nora = { label: "Nora's reply", by: NOW + 60 * MIN }
    expect(line([], { waits: [nora] })).toEqual({ kind: 'wait', wait: nora, more: 0 })
    expect(line([], { waits: [nora, { label: 'CI' }] })).toEqual({
      kind: 'wait',
      wait: nora,
      more: 1
    })
  })

  it('says Paused for a paused bot, whatever it last did', () => {
    expect(
      line(
        [
          session('chat', {
            state: 'working',
            updatedAt: NOW - MIN,
            toolName: 'Read'
          })
        ],
        {
          paused: true,
          waits: [{ label: 'CI' }]
        }
      )
    ).toEqual({ kind: 'paused' })
  })

  it('says where it is replying, never the agent name, until the bot posts a status', () => {
    const working = (sessionId: string) =>
      session(sessionId, { state: 'working', updatedAt: NOW - MIN, prompt: 'hi' })
    expect(line([working('slack-thread')])).toEqual({
      kind: 'replying',
      place: { source: 'slack', label: '#releases' }
    })
    expect(line([working('linear-thread')])).toEqual({
      kind: 'replying',
      place: { source: 'linear', label: 'ENG-42' }
    })
    expect(
      line([working('github-thread')], {
        links: [link('github-thread', 'github', { place: '#3412' })]
      })
    ).toEqual({ kind: 'replying', place: { source: 'github', label: '#3412' } })
    expect(line([working('chat')])).toEqual({ kind: 'replying', place: null })
    // A finished turn that said nothing has no line rather than the agent's name.
    expect(line([session('chat', { state: 'done', updatedAt: NOW - MIN })])).toBeNull()
  })

  it('says it is reading the message while its Chat or a thread is starting its agent', () => {
    const done = session('chat', {
      state: 'done',
      updatedAt: NOW - MIN,
      lastAssistantMessage: 'Older'
    })
    expect(line([done], { startingSessionIds: new Set(['chat']) })).toEqual({ kind: 'reading' })
    expect(line([done], { startingSessionIds: new Set(['slack-thread']) })).toEqual({
      kind: 'reading'
    })
    expect(line([done], { startingSessionIds: new Set(['run']) })).toMatchObject({
      kind: 'activity',
      text: 'Older'
    })
  })

  it('has no line before the bot has done anything', () => {
    expect(line([])).toBeNull()
  })
})
