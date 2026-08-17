import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  isLaunchPromptMessageId,
  launchPromptAsMessage,
  shouldPruneLaunchPrompt
} from './native-chat-launch-prompt'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

function message(id: string, role: 'user' | 'assistant', text: string): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function transcriptOrder(
  highWater: number,
  sequences: Record<string, number> = {}
): NativeChatTranscriptOrder {
  return { generation: 0, highWater, messageSequenceById: new Map(Object.entries(sequences)) }
}

describe('native chat launch prompt', () => {
  it('maps a launch prompt to a tab-keyed scrape-source user message', () => {
    expect(
      launchPromptAsMessage({
        tabId: 'tab-1',
        agent: 'codex',
        text: 'Fix failing checks',
        createdAt: 42
      })
    ).toEqual({
      id: 'launch-pending:tab-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix failing checks' }],
      timestamp: 42,
      source: 'scrape'
    })
  })

  it('hides the launch prompt while its transcript user turn is visible', () => {
    const entry = { tabId: 'tab-1', agent: 'codex' as const, text: 'Fix checks', createdAt: 42 }
    const transcript = [{ ...message('u1', 'user', 'Fix checks'), timestamp: 43 }]

    expect(launchPromptAsMessage(entry, transcript)).toBeNull()
  })

  it('uses pending-send normalization for large multiline generated prompts', () => {
    const prompt = [
      '[Image #1] Resolve the failing checks:',
      '',
      'Resolve the failing checks:',
      '',
      '- lint failed',
      '  fix spacing'
    ].join('\n')
    const transcript = [
      {
        ...message(
          'u1',
          'user',
          'Resolve the failing checks: Resolve the failing checks: - lint failed fix spacing'
        ),
        timestamp: 43
      },
      { ...message('a1', 'assistant', 'I will fix it'), timestamp: 44 }
    ]

    expect(
      shouldPruneLaunchPrompt(
        { tabId: 'tab-1', agent: 'codex', text: prompt, createdAt: 42 },
        transcript
      )
    ).toBe(true)
  })

  it('keeps the launch prompt until the transcript advances past the user turn', () => {
    const prompt = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'Fix failing checks',
      createdAt: 42
    }
    const user = { ...message('u1', 'user', 'Fix failing checks'), timestamp: 43 }

    expect(shouldPruneLaunchPrompt(prompt, [user])).toBe(false)
    expect(
      shouldPruneLaunchPrompt(prompt, [
        user,
        { ...message('a1', 'assistant', 'working'), timestamp: 44 }
      ])
    ).toBe(true)
  })

  it('hides and prunes against a timestampless transcript', () => {
    const entry = { tabId: 'tab-1', agent: 'grok' as const, text: 'rename it', createdAt: 42 }
    const transcript = [
      { ...message('u1', 'user', 'rename it'), timestamp: null },
      { ...message('a1', 'assistant', 'done'), timestamp: null }
    ]

    expect(launchPromptAsMessage(entry, transcript)).toBeNull()
    expect(shouldPruneLaunchPrompt(entry, transcript)).toBe(true)
  })

  it('does not bind to an older identical completed turn', () => {
    const entry = { tabId: 'tab-1', agent: 'claude' as const, text: 'run tests', createdAt: 100 }
    const oldHistory = [
      { ...message('old-user', 'user', 'run tests'), timestamp: 10 },
      { ...message('old-answer', 'assistant', 'passed'), timestamp: 20 }
    ]

    expect(launchPromptAsMessage(entry, oldHistory)).not.toBeNull()
    expect(shouldPruneLaunchPrompt(entry, oldHistory)).toBe(false)
  })

  it('matches by transcript order when the remote host clock is behind', () => {
    const entry = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'run tests',
      createdAt: 1_000_000
    }
    const transcript = [
      { ...message('old-user', 'user', 'run tests'), timestamp: 10 },
      { ...message('old-answer', 'assistant', 'passed'), timestamp: 20 },
      { ...message('new-user', 'user', 'run tests'), timestamp: 30 },
      { ...message('new-answer', 'assistant', 'passed again'), timestamp: 40 }
    ]
    const options = {
      crossClock: true,
      transcriptOrder: transcriptOrder(2, { 'new-user': 1, 'new-answer': 2 })
    }

    expect(launchPromptAsMessage(entry, transcript, options)).toBeNull()
    expect(shouldPruneLaunchPrompt(entry, transcript, options)).toBe(true)
  })

  it('keeps a remote prompt when only an unsequenced older turn matches', () => {
    const entry = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'run tests',
      createdAt: 1_000_000
    }
    const oldHistory = [
      { ...message('old-user', 'user', 'run tests'), timestamp: 10 },
      { ...message('old-answer', 'assistant', 'passed'), timestamp: 20 }
    ]
    const options = { crossClock: true, transcriptOrder: transcriptOrder(0) }

    expect(launchPromptAsMessage(entry, oldHistory, options)).not.toBeNull()
    expect(shouldPruneLaunchPrompt(entry, oldHistory, options)).toBe(false)
  })

  it('recognizes the launch prompt id prefix', () => {
    expect(isLaunchPromptMessageId('launch-pending:tab-1')).toBe(true)
    expect(isLaunchPromptMessageId('pending:p1')).toBe(false)
  })
})
