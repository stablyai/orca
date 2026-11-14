import { describe, expect, it } from 'vitest'
import { DictationTranscript } from './dictation-transcript'

function fold(events: { type: 'partial' | 'final'; text: string }[]) {
  const transcript = new DictationTranscript()
  events.forEach((event) => transcript.accept(event))
  return transcript.snapshot()
}

describe('DictationTranscript', () => {
  it('joins Chinese and Japanese phrases without a space, as they are inserted', () => {
    expect(
      fold([
        { type: 'final', text: '西班牙人开始了殖民时期。' },
        { type: 'final', text: '2023年他们来自欧洲' },
        { type: 'partial', text: '然后' }
      ])
    ).toMatchObject({
      committed: '西班牙人开始了殖民时期。2023年他们来自欧洲',
      text: '西班牙人开始了殖民时期。2023年他们来自欧洲然后'
    })
    expect(
      fold([
        { type: 'final', text: '今日は晴れです。' },
        { type: 'final', text: '散歩に行きます。' }
      ]).committed
    ).toBe('今日は晴れです。散歩に行きます。')
  })

  it('spaces Korean and Latin phrases', () => {
    expect(
      fold([
        { type: 'final', text: '안녕하세요.' },
        { type: 'final', text: '감사합니다.' }
      ]).committed
    ).toBe('안녕하세요. 감사합니다.')
    expect(
      fold([
        { type: 'final', text: 'Open the file.' },
        { type: 'partial', text: 'then save' }
      ]).text
    ).toBe('Open the file. then save')
  })
})
