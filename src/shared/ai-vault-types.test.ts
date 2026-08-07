import { describe, expect, it } from 'vitest'
import {
  aiVaultSessionRecoverableSignalCount,
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent,
  isAiVaultSubagentResumable,
  type AiVaultAgent,
  type AiVaultSessionPreviewMessage,
  type AiVaultSessionSubagentInfo
} from './ai-vault-types'

type SignalFields = {
  messageCount: number
  previewMessages: AiVaultSessionPreviewMessage[]
  queuedMessageCount: number
  subagentTranscriptCount: number
}

function signal(overrides: Partial<SignalFields> = {}): SignalFields {
  return {
    messageCount: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    ...overrides
  }
}

function preview(role: AiVaultSessionPreviewMessage['role']): AiVaultSessionPreviewMessage {
  return { role, text: 'preview text', timestamp: null }
}

describe('isAiVaultSessionResumableContent', () => {
  it('is true when the transcript holds conversation turns', () => {
    expect(isAiVaultSessionResumableContent(signal({ messageCount: 2 }))).toBe(true)
    expect(isAiVaultSessionResumableContent(signal())).toBe(false)
  })

  it('accepts conversation previews when the turn count is missing', () => {
    // Some parsers (Grok, OpenCode fallback schemas) derive messageCount from
    // metadata that can be absent while real turns exist in previews.
    expect(isAiVaultSessionResumableContent(signal({ previewMessages: [preview('user')] }))).toBe(
      true
    )
    expect(
      isAiVaultSessionResumableContent(signal({ previewMessages: [preview('assistant')] }))
    ).toBe(true)
  })

  it('ignores non-conversation previews', () => {
    expect(isAiVaultSessionResumableContent(signal({ previewMessages: [preview('system')] }))).toBe(
      false
    )
  })
})

describe('isAiVaultSessionRecoverableEmpty', () => {
  it('is true for a zero-turn session with queued or subagent signal', () => {
    expect(isAiVaultSessionRecoverableEmpty(signal({ queuedMessageCount: 3 }))).toBe(true)
    expect(isAiVaultSessionRecoverableEmpty(signal({ subagentTranscriptCount: 1 }))).toBe(true)
  })

  it('is false for a plain empty session or one with resumable content', () => {
    expect(isAiVaultSessionRecoverableEmpty(signal())).toBe(false)
    expect(
      isAiVaultSessionRecoverableEmpty(signal({ messageCount: 2, queuedMessageCount: 4 }))
    ).toBe(false)
    expect(
      isAiVaultSessionRecoverableEmpty(
        signal({ previewMessages: [preview('user')], queuedMessageCount: 4 })
      )
    ).toBe(false)
  })
})

describe('aiVaultSessionRecoverableSignalCount', () => {
  it('sums queued messages and subagent transcripts, clamping negatives', () => {
    expect(
      aiVaultSessionRecoverableSignalCount({
        queuedMessageCount: 4,
        subagentTranscriptCount: 2
      })
    ).toBe(6)
    expect(
      aiVaultSessionRecoverableSignalCount({
        queuedMessageCount: -1,
        subagentTranscriptCount: 3
      })
    ).toBe(3)
  })
})

describe('isAiVaultSubagentResumable', () => {
  const child: AiVaultSessionSubagentInfo = {
    parentSessionId: 'parent-session',
    agentType: null,
    status: null
  }

  function row(overrides: {
    agent?: AiVaultAgent
    subagent?: AiVaultSessionSubagentInfo | null
    messageCount?: number
  }) {
    return {
      agent: overrides.agent ?? 'omp',
      subagent: overrides.subagent === undefined ? child : overrides.subagent,
      messageCount: overrides.messageCount ?? 3,
      previewMessages: []
    }
  }

  it('resumes an OMP subagent, which has its own session id and resumes by path', () => {
    expect(isAiVaultSubagentResumable(row({}))).toBe(true)
  })

  it('refuses a Claude subagent, whose resume would reopen the parent', () => {
    // Claude subagents share the parent's sessionId and resume by id, so
    // offering resume here relaunches the parent rather than the row clicked.
    expect(isAiVaultSubagentResumable(row({ agent: 'claude' }))).toBe(false)
  })

  it('refuses a zero-turn subagent, which would resume into an empty session', () => {
    expect(isAiVaultSubagentResumable(row({ messageCount: 0 }))).toBe(false)
  })

  it('refuses a top-level session, which has its own resume affordances', () => {
    expect(isAiVaultSubagentResumable(row({ subagent: null }))).toBe(false)
  })
})
