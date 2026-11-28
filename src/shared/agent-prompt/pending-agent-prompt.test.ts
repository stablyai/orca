import { describe, expect, it } from 'vitest'
import type { PendingPrompt } from '../agent-status/contracts/agent-pending-prompt'
import {
  mapChatPrompt,
  mapTerminalPrompt,
  parseChatPromptId,
  parseTerminalPromptId,
  type ChatPromptSourceItem
} from './pending-agent-prompt'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture is one approval item; the mapper reads only these fields.
const approval = {
  itemId: 'item:1',
  revision: 4,
  observedAt: 1_700_000_000_000,
  body: {
    kind: 'approval',
    title: 'Run Bash',
    displayName: 'Bash',
    detail: `  ${'a'.repeat(295)}\n`,
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'allow_always', label: 'Always' },
      { id: 'reject_once', label: 'Reject' },
      { id: 'yes', label: 'Allow always' }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
} as ChatPromptSourceItem

describe('pending agent prompts', () => {
  it('maps a chat approval whose item id contains a colon', () => {
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: 'folder-notes',
        agent: 'claude',
        item: approval
      })
    ).toEqual({
      promptId: 'chat:session01:item:1:4',
      kind: 'permission',
      target: { type: 'chat', sessionId: 'session01' },
      worktreeId: 'folder-notes',
      agent: 'claude',
      title: 'Run Bash',
      detail: `Bash: ${'a'.repeat(293)}…`,
      options: [
        { optionId: 'allow', label: 'Allow', role: 'approve' },
        { optionId: 'allow_always', label: 'Always', role: 'approve-always' },
        { optionId: 'reject_once', label: 'Reject', role: 'deny' },
        { optionId: 'yes', label: 'Allow always', role: 'approve-always' }
      ],
      createdAt: 1_700_000_000_000
    })
    expect(parseChatPromptId('chat:session01:item:1:4')).toEqual({
      sessionId: 'session01',
      itemId: 'item:1',
      revision: 4
    })
  })

  it('collapses whitespace in a short approval detail', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture is one approval item; the mapper reads only these fields.
    const item = {
      ...approval,
      body: { ...approval.body, detail: 'ls\n-la' }
    } as ChatPromptSourceItem
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: 'folder-notes',
        agent: 'claude',
        item
      })?.detail
    ).toBe('Bash: ls -la')
  })

  it('keeps a one-choice question and leaves numbered options as other', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture is one question item; the mapper reads only these fields.
    const item = {
      itemId: 'q1',
      revision: 2,
      observedAt: 20,
      body: {
        kind: 'question',
        question: 'Ship it?',
        options: [
          { id: '1', label: 'Yes' },
          { id: '2', label: 'No' }
        ],
        questions: [
          {
            id: 'q',
            question: 'Ship it?',
            multiSelect: false,
            options: [{ id: '1', label: 'Yes' }]
          }
        ],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    } as ChatPromptSourceItem
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: 'folder-notes',
        agent: 'claude',
        item
      })
    ).toEqual({
      promptId: 'chat:session01:q1:2',
      kind: 'question',
      target: { type: 'chat', sessionId: 'session01' },
      worktreeId: 'folder-notes',
      agent: 'claude',
      title: 'Ship it?',
      options: [
        { optionId: '1', label: 'Yes', role: 'other' },
        { optionId: '2', label: 'No', role: 'other' }
      ],
      createdAt: 20
    })
  })

  it('skips questions that one option id cannot answer', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture is one question item; the mapper reads only these fields.
    const many = {
      ...approval,
      body: {
        kind: 'question',
        question: 'Pick',
        options: [{ id: '1', label: 'A' }],
        questions: [
          { id: 'a', question: 'A', multiSelect: false, options: [] },
          { id: 'b', question: 'B', multiSelect: false, options: [] }
        ],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    } as ChatPromptSourceItem
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture is one question item; the mapper reads only these fields.
    const multi = {
      ...many,
      body: {
        ...many.body,
        questions: [{ id: 'a', question: 'A', multiSelect: true, options: [] }]
      }
    } as ChatPromptSourceItem
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: 'folder-notes',
        agent: 'claude',
        item: many
      })
    ).toBeNull()
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: 'folder-notes',
        agent: 'claude',
        item: multi
      })
    ).toBeNull()
    expect(
      mapChatPrompt({
        sessionId: 'session01',
        worktreeId: '',
        agent: 'claude',
        item: approval
      })
    ).toBeNull()
  })

  it('maps a terminal approval and a numbered question, and drops unsupported prompts', () => {
    const approvalPrompt: PendingPrompt = {
      kind: 'approval',
      promptId: 'p_26bea7ae07aef52f093a',
      tool: 'Bash',
      summary: 'ls',
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'reject_once', label: 'Reject' }
      ]
    }
    expect(
      mapTerminalPrompt({
        ptyId: 'pty:ssh:1',
        handle: 'term-ssh',
        worktreeId: 'repo::feature',
        agent: 'claude',
        createdAt: 50,
        prompt: approvalPrompt
      })
    ).toEqual({
      promptId: 'term:pty:ssh:1:26bea7ae07aef52f093a',
      kind: 'permission',
      target: { type: 'terminal', terminal: 'term-ssh' },
      worktreeId: 'repo::feature',
      agent: 'claude',
      title: 'Bash',
      detail: 'Bash: ls',
      options: [
        { optionId: 'allow_once', label: 'Allow once', role: 'approve' },
        { optionId: 'reject_once', label: 'Reject', role: 'deny' }
      ],
      createdAt: 50
    })
    const question: PendingPrompt = {
      kind: 'question',
      promptId: 'p_bdb13313988be0581b7b',
      question: 'Which env?',
      header: 'Deploy',
      options: [{ id: '1', label: 'Prod' }]
    }
    expect(
      mapTerminalPrompt({
        ptyId: 'folder-pty',
        handle: 'term-folder',
        worktreeId: 'folder-notes',
        agent: 'claude',
        createdAt: 60,
        prompt: question
      })
    ).toMatchObject({
      promptId: 'term:folder-pty:bdb13313988be0581b7b',
      kind: 'question',
      title: 'Which env?',
      detail: 'Deploy',
      options: [{ optionId: '1', label: 'Prod', role: 'other' }]
    })
    expect(
      mapTerminalPrompt({
        ptyId: 'folder-pty',
        handle: 'term-folder',
        worktreeId: 'folder-notes',
        agent: 'claude',
        createdAt: 60,
        prompt: { kind: 'unsupported', promptId: 'p_bdb13313988be0581b7b' }
      })
    ).toBeNull()
    expect(parseTerminalPromptId('term:pty:ssh:1:26bea7ae07aef52f093a')).toEqual({
      ptyId: 'pty:ssh:1',
      fingerprint: '26bea7ae07aef52f093a'
    })
    expect(parseTerminalPromptId('term:pty:ssh:1:not-a-fingerprint')).toBeNull()
    expect(parseChatPromptId('chat:short:item:1:4')).toBeNull()
  })
})
