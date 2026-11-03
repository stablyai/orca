import { describe, expect, it } from 'vitest'
import { tokenizeMonarchDocument, tokenLanguages } from './monarch-tokenizer-test-harness'
import { vueMonarchLanguage } from './register-vue'

// Use real Monarch tokenization; valid rule tables previously hid throws on every interpolation.
function tokenizeVue(source: string) {
  return tokenizeMonarchDocument('vue', vueMonarchLanguage, source)
}

describe('vue tokenization', () => {
  it('does not enter typescript for an empty interpolation', () => {
    // Empty interpolation pushes no TypeScript; unwind state without popping a nonexistent embed.
    const [, line] = tokenizeVue('<template>\n  <p>{{}}</p>\n</template>')

    expect(tokenLanguages(line)).toEqual(['html', 'vue', 'html'])
  })
})
