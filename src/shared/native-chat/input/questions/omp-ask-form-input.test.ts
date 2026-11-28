import { describe, expect, it } from 'vitest'
import { parseAskFromToolInput } from '../native-chat-ask'
import { parseInteractivePrompt } from '../native-chat-interactive-prompt'

// OMP 18.18.3+ `ask` takes one HTML form instead of `questions[]`.
const input = {
  i: 'Choosing how to ship',
  html: `<form>
  <p>Found two ways to ship this.</p>
  <ul><li>Rebase keeps history linear</li></ul>
  <fieldset>
    <legend>Which base?</legend>
    <label><input type="radio" name="base" value="main" checked> <code>main</code> &amp; tags</label>
    <label><input type="radio" name="base" value="next"> next</label>
  </fieldset>
  <p>Which checks should run?</p>
  <label><input type="checkbox" name="checks" value="lint"> Lint</label>
  <label><input type="checkbox" name="checks" value="test" checked> Tests</label>
  <label>Reviewer <select name="reviewer"><option>Ann<option selected>Bob</select></label>
  <label>Anything else? <textarea name="notes" required></textarea></label>
  <input type="hidden" name="run" value="42">
</form>`
}

describe('OMP ask form input', () => {
  it('reads each named control as the question OMP asks, from live status and transcript alike', () => {
    const prompt = {
      questions: [
        {
          question: 'Which base?',
          multiSelect: false,
          options: [{ label: 'main & tags', recommended: true }, { label: 'next' }]
        },
        {
          question: 'Which checks should run?',
          multiSelect: true,
          options: [{ label: 'Lint' }, { label: 'Tests', recommended: true }]
        },
        {
          question: 'Reviewer',
          multiSelect: false,
          options: [{ label: 'Ann' }, { label: 'Bob', recommended: true }]
        },
        { question: 'Anything else?', multiSelect: false, options: [], required: true }
      ]
    }

    expect(parseInteractivePrompt(JSON.stringify(input), 'ask', 'omp')).toEqual({
      kind: 'question',
      prompt
    })
    expect(parseAskFromToolInput('ask', input)).toEqual(prompt)
  })

  it('reads hostile nesting without overflowing the stack', () => {
    const html = `<form>${'<i>'.repeat(5_000)}<p>Which?</p><input type="checkbox" name="pick"></form>`
    expect(parseAskFromToolInput('ask', { html })).toEqual({
      questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'pick' }] }]
    })
  })

  it('reads only the first 16000 chars', () => {
    const late = `<form><p>${'x'.repeat(16_000)}</p><input name="late"></form>`
    expect(parseAskFromToolInput('ask', { html: late })).toBeNull()
  })

  it('never resolves tag or entity names through the prototype', () => {
    const html =
      '<form><constructor><label>&constructor; <input name="a"></label></constructor></form>'
    expect(parseAskFromToolInput('ask', { html })?.questions[0]?.question).toBe('&constructor;')
  })

  it('reads a tool input again when its html changes in place', () => {
    const streamed = { html: '<form><label>First <input name="a"></label></form>' }
    expect(parseAskFromToolInput('ask', streamed)?.questions[0]?.question).toBe('First')
    streamed.html = '<form><label>Second <input name="a"></label></form>'
    expect(parseAskFromToolInput('ask', streamed)?.questions[0]?.question).toBe('Second')
  })

  it('finds controls after a large inline image or drawing', () => {
    const image = `<img alt="Plan" src="data:image/png;base64,${'A'.repeat(40_000)}">`
    const drawing = `<svg viewBox="0 0 9 9">${'<path d="M0 0L9 9"/>'.repeat(2_000)}</svg>`
    const html = `<form>${image}${drawing}<label>Ship it? <input type="checkbox" name="ship"></label></form>`
    expect(parseAskFromToolInput('ask', { html })?.questions).toEqual([
      { question: 'Ship it?', multiSelect: true, options: [{ label: 'Ship it?' }] }
    ])
  })

  it('preselects a single select first enabled option, as OMP does', () => {
    const html =
      '<form><label>Region <select name="r"><option disabled>Pick</option><option>eu</option><option>us</option></select></label></form>'
    expect(parseAskFromToolInput('ask', { html })?.questions[0]?.options).toEqual([
      { label: 'eu', recommended: true },
      { label: 'us' }
    ])
  })

  it("ends a tag at '>' when an unquoted attribute value holds an apostrophe", () => {
    const html = `<form><input type=checkbox name=ok aria-label=Don't><label>Next <input name="b"></label></form>`
    expect(parseAskFromToolInput('ask', { html })?.questions.map((q) => q.question)).toEqual([
      "Don't",
      'Next'
    ])
  })

  it('keeps the questions read for a form when a fresh snapshot brings it again', () => {
    const asks = Array.from({ length: 150 }, (_, index) => ({
      html: `<form><p>${'Context. '.repeat(250)}</p><label>Ask ${index} <input name="a"></label></form>`
    }))
    const first = asks.map((ask) => parseAskFromToolInput('ask', ask))
    const reconnect = structuredClone(asks).map((ask) => parseAskFromToolInput('ask', ask))
    expect(reconnect.every((prompt, index) => prompt === first[index])).toBe(true)
    expect(reconnect[149]?.questions[0]?.question).toBe('Ask 149')
  })
})
