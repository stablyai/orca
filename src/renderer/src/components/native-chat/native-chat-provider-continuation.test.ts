// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  stageNativeChatProviderContinuation,
  bindNativeChatProviderContinuation,
  readNativeChatProviderContinuation,
  withNativeChatProviderHistory,
  prepareNativeChatContinuationSend,
  writeNativeChatProviderContinuation
} from './native-chat-provider-continuation'
import { loadNativeChatProviderContinuations } from './native-chat-provider-continuation-storage'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const prior: NativeChatMessage = {
  id: 'old-answer',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Prior answer' }],
  timestamp: 1,
  source: 'transcript'
}
const stage = () =>
  stageNativeChatProviderContinuation({
    paneKey: 'pane',
    sourcePtyId: 'old',
    agent: 'codex',
    messages: [prior],
    transcriptPath: null
  })
const prepare = () =>
  prepareNativeChatContinuationSend({
    paneKey: 'pane',
    agent: 'codex',
    ptyId: 'new',
    text: 'Continue here'
  })

describe('terminal chat provider continuation', () => {
  beforeEach(() => {
    resetNativeChatPtySendQueuesForTests()
    writeNativeChatProviderContinuation('pane', null)
    vi.useRealTimers()
  })
  it('retains history and passes context only in the first provider send', () => {
    stage()
    const first = prepare()
    expect(first.text).toContain('Prior answer')
    expect(first.text).toContain('Current user message:\nContinue here')
    expect(prepare().text).toBe('Continue here')
    const next: NativeChatMessage = {
      ...prior,
      id: 'new-user',
      role: 'user',
      blocks: [{ type: 'text', text: first.text }]
    }
    const visible = withNativeChatProviderHistory(
      readNativeChatProviderContinuation('pane'),
      'codex',
      [next]
    )
    expect(visible).toEqual([prior, { ...next, blocks: [{ type: 'text', text: 'Continue here' }] }])
  })
  it('embeds the visible conversation even when a source transcript is available', () => {
    stageNativeChatProviderContinuation({
      paneKey: 'pane',
      sourcePtyId: 'old',
      agent: 'codex',
      messages: [prior],
      transcriptPath: '/source/transcript.jsonl'
    })
    expect(prepare().text).toContain('Prior answer')
  })
  it('redacts a Grok handoff with a truncated opening while preserving unrelated text', () => {
    stage()
    const first = prepare()
    const next: NativeChatMessage = {
      ...prior,
      id: 'new-user',
      role: 'user',
      blocks: [{ type: 'text', text: first.text.slice(7) }]
    }
    const record = readNativeChatProviderContinuation('pane')
    expect(withNativeChatProviderHistory(record, 'codex', [next])[1].blocks).toEqual([
      { type: 'text', text: 'Continue here' }
    ])
    const unrelated = {
      ...next,
      blocks: [{ type: 'text' as const, text: 'Current user message:\nContinue here' }]
    }
    expect(withNativeChatProviderHistory(record, 'codex', [unrelated])[1]).toEqual(unrelated)
  })
  it('preserves and redacts history for the actual provider on the bound replacement terminal', () => {
    stage()
    const first = prepare()
    const next: NativeChatMessage = {
      ...prior,
      id: 'new-user',
      role: 'user',
      blocks: [{ type: 'text', text: first.text }]
    }
    expect(
      withNativeChatProviderHistory(
        readNativeChatProviderContinuation('pane'),
        'claude',
        [next],
        'new'
      )
    ).toEqual([prior, { ...next, blocks: [{ type: 'text', text: 'Continue here' }] }])
    expect(
      withNativeChatProviderHistory(
        readNativeChatProviderContinuation('pane'),
        'claude',
        [next],
        'unrelated'
      )
    ).toEqual([next])
  })
  it('delivers context to the actual provider only on its confirmed replacement terminal', () => {
    stage()
    bindNativeChatProviderContinuation('pane', 'old', 'new')
    expect(
      prepareNativeChatContinuationSend({
        paneKey: 'pane',
        agent: 'claude',
        ptyId: 'unrelated',
        text: 'Hello'
      }).text
    ).toBe('Hello')
    expect(
      prepareNativeChatContinuationSend({
        paneKey: 'pane',
        agent: 'claude',
        ptyId: 'new',
        text: 'Hello'
      }).text
    ).toContain('Prior answer')
  })
  it('restores both pending context and the exact message redaction after reload', () => {
    stage()
    expect(loadNativeChatProviderContinuations().get('pane')?.context).toContain('Prior answer')
    const first = prepare()
    const restored = loadNativeChatProviderContinuations().get('pane')!
    expect(restored.messages).toEqual([prior])
    expect(restored.firstSend?.wireText).toBe(first.text)
    expect(restored.firstSend?.visibleText).toBe('Continue here')
  })
  it('sends context after an acknowledged replacement reuses the source terminal ID', () => {
    stage()
    const send = () =>
      prepareNativeChatContinuationSend({
        paneKey: 'pane',
        agent: 'codex',
        ptyId: 'old',
        text: 'Continue here'
      })
    expect(send().text).toBe('Continue here')
    bindNativeChatProviderContinuation('pane', 'old', 'old')
    expect(send().text).toContain('Prior answer')
    expect(send().text).toBe('Continue here')
  })
  it('restores context when an option command cancels the original queue handle', async () => {
    vi.useFakeTimers()
    stage()
    const first = prepare()
    const handle = enqueueNativeChatPtySend('new', 500, ({ delay, markSubmitted }) =>
      delay(500, markSubmitted)
    )
    first.track(handle)
    cancelNativeChatPtySends('new')
    await handle.settled
    expect(readNativeChatProviderContinuation('pane')?.firstSend).toBeUndefined()
    expect(prepare().text).toContain('Prior answer')
  })
  it('does not resend context after a submitted handle is cancelled', async () => {
    vi.useFakeTimers()
    stage()
    const first = prepare()
    const handle = first.track(
      enqueueNativeChatPtySend('new', 500, ({ delay, markSubmitted }) => delay(500, markSubmitted))
    )
    await vi.advanceTimersByTimeAsync(500)
    handle.cancel()
    expect(prepare().text).toBe('Continue here')
  })
  it('does not send context into the source provider or a different pane', () => {
    stage()
    expect(
      prepareNativeChatContinuationSend({
        paneKey: 'pane',
        agent: 'codex',
        ptyId: 'old',
        text: 'Hi'
      }).text
    ).toBe('Hi')
    expect(
      prepareNativeChatContinuationSend({
        paneKey: 'other',
        agent: 'codex',
        ptyId: 'new',
        text: 'Hi'
      }).text
    ).toBe('Hi')
  })
  it('restores the previous conversation when a switch fails', () => {
    const rollback = stage()
    rollback()
    expect(readNativeChatProviderContinuation('pane')).toBeNull()
    expect(loadNativeChatProviderContinuations().has('pane')).toBe(false)
  })
})
