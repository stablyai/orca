import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StsModelTurnTaking, type StsTurnOutput } from './sts-model-turn-taking'
import type { StsTurnPrediction } from './sts-turn-models'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture(initial: StsTurnOutput | null = { text: '설명 중입니다.' }) {
  let output = initial
  const predict = vi.fn(async (): Promise<StsTurnPrediction> => ({
    intent: 'speech',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.99
  }))
  const interrupt = vi.fn(),
    utterance = vi.fn(),
    caption = vi.fn(),
    error = vi.fn()
  const gate = new StsModelTurnTaking({
    output: () => output,
    predict,
    interrupt,
    utterance,
    caption,
    error
  })
  return {
    gate,
    predict,
    interrupt,
    utterance,
    caption,
    error,
    end: () => {
      output = null
      gate.outputEnded()
    }
  }
}

it('keeps captions immediate and ignores stale asynchronous judgments after corrected recognition', async () => {
  const f = fixture()
  let finish: ((value: StsTurnPrediction) => void) | undefined
  f.predict.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  f.gate.receive('인식 오류', false)
  expect(f.caption).toHaveBeenLastCalledWith('인식 오류')
  await vi.advanceTimersByTimeAsync(120)
  f.gate.receive('추임새로 수정됨', true)
  f.predict.mockResolvedValue({
    intent: 'backchannel',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.99
  })
  finish?.({ intent: 'speech', confidence: 0.99, expectsAnswer: false, complete: 0.99 })
  await vi.advanceTimersByTimeAsync(500)
  expect(f.interrupt).not.toHaveBeenCalled()
  expect(f.utterance).not.toHaveBeenCalled()
})

it('uses model context to preserve an acknowledgment answering a question', async () => {
  const f = fixture({ text: '진행해도 괜찮을지 알려주세요.' })
  f.predict.mockResolvedValue({
    intent: 'backchannel',
    confidence: 0.99,
    expectsAnswer: true,
    complete: 0.99
  })
  f.gate.receive('네', true)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.utterance).not.toHaveBeenCalled()
  f.end()
  expect(f.utterance).toHaveBeenCalledExactlyOnceWith('네')
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('retains an incomplete utterance across STT commits, without Korean suffix rules', async () => {
  const f = fixture(null)
  f.predict.mockResolvedValue({
    intent: 'speech',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.1
  })
  f.gate.receive('첫 번째 이야기', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.utterance).not.toHaveBeenCalled()
  f.gate.receive('두 번째 이야기', false)
  expect(f.caption).toHaveBeenLastCalledWith('첫 번째 이야기 두 번째 이야기')
  f.predict.mockResolvedValue({
    intent: 'speech',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.9
  })
  f.gate.receive('두 번째 이야기', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.utterance).toHaveBeenCalledExactlyOnceWith('첫 번째 이야기 두 번째 이야기')
})

it('waits for new words instead of submitting a stale deferred answer when output ends', async () => {
  const f = fixture({ text: '진행할까요?' })
  f.predict.mockResolvedValue({
    intent: 'backchannel',
    confidence: 0.99,
    expectsAnswer: true,
    complete: 0.99
  })
  f.gate.receive('네', true)
  await vi.advanceTimersByTimeAsync(10)
  f.gate.receive('먼저 이것부터 해줘', false)
  f.end()
  expect(f.utterance).not.toHaveBeenCalled()
  f.predict.mockResolvedValue({
    intent: 'speech',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.99
  })
  f.gate.receive('먼저 이것부터 해줘', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.utterance).toHaveBeenCalledExactlyOnceWith('네 먼저 이것부터 해줘')
})

it('does not consume uncertain stop predictions and permits manual completion after model failure', async () => {
  const f = fixture()
  f.predict.mockResolvedValue({
    intent: 'stop',
    confidence: 0.86,
    expectsAnswer: false,
    complete: 0.9
  })
  f.gate.receive('멈추지 마', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.utterance).toHaveBeenCalledWith('멈추지 마')
  f.predict.mockRejectedValue(new Error('offline inference failed'))
  f.gate.receive('보존할 말', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.error).toHaveBeenCalledOnce()
  f.gate.submit()
  expect(f.utterance).toHaveBeenLastCalledWith('보존할 말')
})

it('honors a confident stop without sending it, and closing invalidates late results', async () => {
  const f = fixture()
  f.predict.mockResolvedValue({
    intent: 'stop',
    confidence: 0.99,
    expectsAnswer: false,
    complete: 0.9
  })
  f.gate.receive('중단 요청', true)
  await vi.advanceTimersByTimeAsync(10)
  expect(f.interrupt).toHaveBeenCalledOnce()
  expect(f.utterance).not.toHaveBeenCalled()
  f.gate.receive('보내면 안 되는 늦은 결과', true)
  f.gate.close()
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.utterance).not.toHaveBeenCalled()
})
