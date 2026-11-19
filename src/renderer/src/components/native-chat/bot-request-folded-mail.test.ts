// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { foldBotRequestMail, useFoldedIntoBotRequest } from './bot-request-folded-mail'

const notice = (...ids: string[]): AgentMessageSource => ({
  kind: 'agent',
  senders: [],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'orca_session_id:t',
    dispatchId: null,
    messages: ids.map((messageId) => ({ messageId, runId: 'r', from: 'x' }))
  }
})

describe('folded bot-request mail', () => {
  it('folds a notice only once every message it points at is on a card', () => {
    const both = renderHook(() => useFoldedIntoBotRequest(notice('m1', 'm2')))
    const one = renderHook(() => useFoldedIntoBotRequest(notice('m1')))
    expect(both.result.current).toBe(false)
    act(() => foldBotRequestMail(['m1']))
    expect(one.result.current).toBe(true)
    expect(both.result.current).toBe(false)
    expect(renderHook(() => useFoldedIntoBotRequest(undefined)).result.current).toBe(false)
  })
})
