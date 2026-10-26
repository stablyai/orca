import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  localVoiceForLanguage,
  spokenProse,
  StsVoicePlayback,
  voiceMessageText
} from './sts-voice-playback'

function message(id: string, text: string, sequence = 1): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    source: 'transcript',
    timestamp: 1,
    state: 'running',
    journalPosition: { sequence, index: 0 }
  }
}

describe('voice reply playback', () => {
  it('waits for a sentence, speaks each increment once, and flushes the final fragment', () => {
    const playback = new StsVoicePlayback()
    const row = message('reply', '첫 번째')
    expect(playback.next([row], true)).toBeNull()
    row.blocks = [{ type: 'text', text: '첫 번째 문장.\n\n다음 문장' }]
    expect(playback.hasPending([row], true)).toBe(true)
    expect(playback.next([row], true)).toBe('첫 번째 문장.')
    expect(playback.next([row], true)).toBeNull()
    expect(playback.next([row], false)).toBe('다음 문장')
    expect(playback.next([row], false)).toBeNull()
  })

  it('does not replay history, paged history, or the remainder of a paused reply', () => {
    const playback = new StsVoicePlayback()
    const current = message('current', '현재 문장.', 10)
    playback.reset([current])
    current.blocks = [{ type: 'text', text: '현재 문장. 추가 문장.' }]
    expect(playback.next([message('older', '이전 기록.', 5), current], false)).toBeNull()
    expect(playback.next([current, message('new', '새 응답.', 11)], false)).toBe('새 응답.')
  })

  it('never voices tools, reasoning, subagents, or fenced code, including partial fences', () => {
    expect(voiceMessageText({ ...message('reasoning', '비공개'), role: 'reasoning' })).toBe('')
    expect(voiceMessageText({ ...message('child', '자식'), agentId: 'worker' })).toBe('')
    expect(voiceMessageText({ ...message('tool', '명령 출력'), role: 'tool' })).toBe('')
    expect(spokenProse('설명.\n```sh\nrm -rf /')).toBe('설명.')
    expect(spokenProse('설명.\n```sh\ncode\n```\n끝.')).toBe('설명.\n\n끝.')
  })

  it('does not repeat rewritten messages and bounds long utterances', () => {
    const playback = new StsVoicePlayback()
    expect(playback.next([message('a', '원문.')], false)).toBe('원문.')
    expect(playback.next([message('a', '다른 원문.')], false)).toBeNull()
    const long = message('b', '긴'.repeat(1000), 2)
    expect(playback.next([long], true)?.length).toBeLessThanOrEqual(220)
  })

  it('only selects Korean voices explicitly reported as local', () => {
    const remote = { lang: 'ko-KR', localService: false }
    const english = { lang: 'en-US', localService: true }
    const korean = { lang: 'ko-KR', localService: true }
    expect(localVoiceForLanguage([remote, english], 'ko')).toBeUndefined()
    expect(localVoiceForLanguage([remote, english, korean], 'ko')).toBe(korean)
  })
})
