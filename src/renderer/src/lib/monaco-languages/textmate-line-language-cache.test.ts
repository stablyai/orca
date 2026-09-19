// @vitest-environment happy-dom

import * as monaco from 'monaco-editor'
import { afterEach, describe, expect, it } from 'vitest'
import { TextMateLineLanguageCache } from './textmate-line-language-cache'

class LineState implements monaco.languages.IState {
  constructor(readonly previousLines: number) {}

  clone(): LineState {
    return new LineState(this.previousLines)
  }

  equals(other: monaco.languages.IState): boolean {
    return other instanceof LineState && other.previousLines === this.previousLines
  }
}

const models: monaco.editor.ITextModel[] = []

function createModel(value: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(value, 'plaintext')
  models.push(model)
  return model
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('TextMateLineLanguageCache', () => {
  it('tokenizes only through the requested line and reuses the stored line state', async () => {
    let tokenizedLines = 0
    const provider: monaco.languages.EncodedTokensProvider = {
      getInitialState: () => new LineState(0),
      tokenizeEncoded: (_line, state) => {
        tokenizedLines += 1
        const previousLines = state instanceof LineState ? state.previousLines : 0
        return {
          tokens: new Uint32Array([0, previousLines + 1]),
          endState: new LineState(previousLines + 1)
        }
      }
    }
    const cache = new TextMateLineLanguageCache(createModel('one\ntwo\nthree'), provider)

    await expect(cache.getLanguagesAtLineStarts([2, 2])).resolves.toEqual([2, 2])
    expect(tokenizedLines).toBe(2)
    cache.dispose()
  })

  it('invalidates the changed line and every following line', async () => {
    let tokenizedLines = 0
    const provider: monaco.languages.EncodedTokensProvider = {
      getInitialState: () => new LineState(0),
      tokenizeEncoded: (line, state) => {
        tokenizedLines += 1
        const previousLines = state instanceof LineState ? state.previousLines : 0
        return {
          tokens: new Uint32Array([0, line === 'jsx' ? 2 : 1]),
          endState: new LineState(previousLines + 1)
        }
      }
    }
    const model = createModel('code\ncode\ncode')
    const cache = new TextMateLineLanguageCache(model, provider)
    await expect(cache.getLanguagesAtLineStarts([3])).resolves.toEqual([1])

    model.applyEdits([
      {
        range: new monaco.Range(2, 1, 2, 5),
        text: 'jsx'
      }
    ])

    await expect(cache.getLanguagesAtLineStarts([2, 3])).resolves.toEqual([2, 1])
    expect(tokenizedLines).toBe(5)
    cache.dispose()
  })

  it('yields on elapsed-time boundaries and serializes concurrent requests', async () => {
    let tokenizedLines = 0
    let yields = 0
    let now = 0
    const provider: monaco.languages.EncodedTokensProvider = {
      getInitialState: () => new LineState(0),
      tokenizeEncoded: (_line, state) => {
        tokenizedLines += 1
        now += 1
        const previousLines = state instanceof LineState ? state.previousLines : 0
        return {
          tokens: new Uint32Array([0, 1]),
          endState: new LineState(previousLines + 1)
        }
      }
    }
    const cache = new TextMateLineLanguageCache(
      createModel('one\ntwo\nthree\nfour\nfive'),
      provider,
      {
        now: () => now,
        tokenizationTimeSliceMs: 2,
        yieldToEventLoop: async () => {
          yields += 1
        }
      }
    )

    const [throughFive, throughThree] = await Promise.all([
      cache.getLanguagesAtLineStarts([5]),
      cache.getLanguagesAtLineStarts([3])
    ])

    expect(throughFive).toEqual([1])
    expect(throughThree).toEqual([1])
    expect(tokenizedLines).toBe(5)
    expect(yields).toBe(2)
    cache.dispose()
  })

  it('marks the long line and following state as unknown without tokenizing them', async () => {
    const tokenizedLines: string[] = []
    const provider: monaco.languages.EncodedTokensProvider = {
      getInitialState: () => new LineState(0),
      tokenizeEncoded: (line, state) => {
        tokenizedLines.push(line)
        const previousLines = state instanceof LineState ? state.previousLines : 0
        return {
          tokens: new Uint32Array([0, 1]),
          endState: new LineState(previousLines + 1)
        }
      }
    }
    const longLine = 'x'.repeat(19_996)
    const model = createModel(`one\n${longLine}\nfour`)
    const cache = new TextMateLineLanguageCache(model, provider)

    await expect(cache.getLanguagesAtLineStarts([1, 2, 3])).resolves.toEqual([1, null, null])
    expect(tokenizedLines).toEqual(['one'])

    model.applyEdits([{ range: new monaco.Range(2, 1, 2, longLine.length + 1), text: 'two' }])
    await expect(cache.getLanguagesAtLineStarts([3])).resolves.toEqual([1])
    expect(tokenizedLines).toEqual(['one', 'two', 'four'])
    cache.dispose()
  })
})
