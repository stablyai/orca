import { describe, expect, it } from 'vitest'

import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import { DOTENV_LANGUAGE_ID, dotenvMonarchLanguage } from './register-dotenv'

function tokenizeDotenv(source: string) {
  return tokenizeMonarchDocument(DOTENV_LANGUAGE_ID, dotenvMonarchLanguage, source)
}

describe('dotenv tokenization', () => {
  it('colours quoted values, escapes and interpolation', () => {
    const [double, single, bare] = tokenizeDotenv(
      'URL="https://${HOST}:$PORT\\n"\nRAW=\'${HOST}\'\nPATH=$HOME/bin'
    )

    expect(tokenTypeAt(double, 4)).toBe('string')
    expect(tokenTypeAt(double, 13)).toBe('variable')
    expect(tokenTypeAt(double, 21)).toBe('variable')
    expect(tokenTypeAt(double, 26)).toBe('string.escape')
    // Single quotes are literal.
    expect(tokenTypeAt(single, 5)).toBe('string')
    expect(tokenTypeAt(bare, 5)).toBe('variable')
    expect(tokenTypeAt(bare, 10)).toBe('string')
  })

  it('colours whole-value numbers and booleans, but not inside text', () => {
    const [port, debug, version, label] = tokenizeDotenv(
      'PORT=3000\nDEBUG=true # on\nNAME=v1 true\nLABEL=red true'
    )

    expect(tokenTypeAt(port, 5)).toBe('number')
    expect(tokenTypeAt(debug, 6)).toBe('keyword')
    expect(tokenTypeAt(debug, 11)).toBe('comment')
    expect(tokenTypeAt(version, 5)).toBe('string')
    expect(tokenTypeAt(label, 10)).toBe('string')
  })

  it('keeps a quote after the first value character literal', () => {
    const [password, next] = tokenizeDotenv('PASSWORD=abc"def\nNEXT=1')

    expect(tokenTypeAt(password, 12)).toBe('string')
    expect(tokenTypeAt(next, 0)).toBe('type.identifier')
  })

  it('lets a double-quoted value span lines, then resumes keys', () => {
    const [, middle, , after] = tokenizeDotenv('KEY="-----BEGIN\nMIIB==\n-----END"\nNEXT=1')

    expect(tokenTypeAt(middle, 0)).toBe('string')
    expect(tokenTypeAt(after, 0)).toBe('type.identifier')
  })
})
