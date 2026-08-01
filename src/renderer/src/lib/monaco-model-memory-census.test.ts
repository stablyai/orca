import { describe, expect, it } from 'vitest'
import { collectRendererMemoryProfileCounts } from './renderer-memory-profile'
import {
  readMonacoModelCensus,
  setMonacoModelCensusReader,
  summarizeMonacoModelSizes
} from './monaco-model-memory-census'

function model(chars: number, lines: number, disposed = false) {
  return {
    isDisposed: () => disposed,
    getValueLength: () => (disposed ? raise() : chars),
    getLineCount: () => (disposed ? raise() : lines)
  }
}

/** Disposed models throw on text access in real monaco; make the fakes do the same. */
function raise(): never {
  throw new Error('model is disposed')
}

describe('summarizeMonacoModelSizes', () => {
  it('sums the whole registry, which is what outlives the panels', () => {
    expect(summarizeMonacoModelSizes([model(1_000, 40), model(2_500, 90)])).toEqual({
      models: 2,
      chars: 3_500,
      lines: 130
    })
  })

  // Why: a disposed model still occupies a registry slot, and reading its text throws.
  // Counting it while skipping its size keeps the slot visible without a bogus number.
  it('counts a disposed model without reading its text', () => {
    expect(summarizeMonacoModelSizes([model(1_000, 40), model(0, 0, true)])).toEqual({
      models: 2,
      chars: 1_000,
      lines: 40
    })
  })

  // Why: monaco can dispose a model between the isDisposed() guard and the read, and
  // one throw aborting the loop wipes every other model's size from the OOM report.
  it('counts a model that throws after the disposed guard without losing its siblings', () => {
    const racing = {
      isDisposed: () => false,
      getValueLength: raise,
      getLineCount: raise
    }

    expect(summarizeMonacoModelSizes([racing, model(1_000, 40)])).toEqual({
      models: 2,
      chars: 1_000,
      lines: 40
    })
  })

  it('counts no size for a model that throws between its two reads', () => {
    const halfRead = {
      isDisposed: () => false,
      getValueLength: () => 1_000,
      getLineCount: raise
    }

    expect(summarizeMonacoModelSizes([halfRead])).toEqual({ models: 1, chars: 0, lines: 0 })
  })

  it('reports zeros for an empty registry rather than omitting fields', () => {
    expect(summarizeMonacoModelSizes([])).toEqual({ models: 0, chars: 0, lines: 0 })
  })
})

describe('monaco model memory census', () => {
  it('reports zeros before monaco loads, so a missing key means the instrument never ran', () => {
    expect(readMonacoModelCensus()).toEqual({ models: 0, chars: 0, lines: 0 })
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'monacoModels.models': 0,
      'monacoModels.chars': 0,
      'monacoModels.lines': 0
    })
  })

  it('surfaces models retained past their panel, which editorContent.chars reads as zero', () => {
    // Why: models live in monaco's global registry and are disposed only on tab
    // close, so an unmounted panel leaves its text fully retained and unmeasured.
    setMonacoModelCensusReader(() => ({ models: 214, chars: 91_324_887, lines: 2_140_000 }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'monacoModels.models': 214,
      'monacoModels.chars': 91_324_887,
      'monacoModels.lines': 2_140_000
    })

    setMonacoModelCensusReader(() => ({ models: 0, chars: 0, lines: 0 }))
  })
})
