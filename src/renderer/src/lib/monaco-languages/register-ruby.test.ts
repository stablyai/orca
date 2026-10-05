import { describe, expect, it } from 'vitest'
import {
  RUBY_LANGUAGE_ID,
  RUBY_TEXTMATE_SCOPE,
  loadRubyTextMateGrammar,
  rubyTextMateRegistration
} from './register-ruby'

describe('rubyTextMateRegistration', () => {
  it("replaces the built-in Ruby tokenizer and keeps Monaco's Ruby language configuration", () => {
    expect(rubyTextMateRegistration).toMatchObject({
      scopeName: RUBY_TEXTMATE_SCOPE,
      loadGrammar: loadRubyTextMateGrammar,
      replaceExistingTokenizer: true
    })
    expect(rubyTextMateRegistration.configuration).toBeUndefined()
  })

  it('only names the pre-registered Ruby language', () => {
    expect(rubyTextMateRegistration.language).toEqual({ id: RUBY_LANGUAGE_ID })
  })
})

describe('loadRubyTextMateGrammar', () => {
  it('loads the vendored VS Code Ruby grammar for the Ruby scope', async () => {
    await expect(loadRubyTextMateGrammar(RUBY_TEXTMATE_SCOPE)).resolves.toMatchObject({
      name: 'Ruby',
      scopeName: RUBY_TEXTMATE_SCOPE
    })
  })

  it.each(['source.sql', 'text.html.basic', 'source.python'])(
    'returns null for the unvendored scope %s',
    async (scopeName) => {
      await expect(loadRubyTextMateGrammar(scopeName)).resolves.toBeNull()
    }
  )
})
