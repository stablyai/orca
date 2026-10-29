import { describe, expect, it, vi } from 'vitest'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import {
  DOTENV_LANGUAGE_ID,
  dotenvLanguageConfiguration,
  dotenvMonarchLanguage,
  registerDotenvLanguage
} from './register-dotenv'

function tokenizeDotenv(source: string) {
  return tokenizeMonarchDocument(DOTENV_LANGUAGE_ID, dotenvMonarchLanguage, source)
}

function createMonacoMock(existingLanguageIds: string[] = []) {
  return {
    languages: {
      getLanguages: vi.fn(() => existingLanguageIds.map((id) => ({ id }))),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}

describe('registerDotenvLanguage', () => {
  it('registers the dotenv language with a Monarch tokenizer', () => {
    const monaco = createMonacoMock()

    registerDotenvLanguage(monaco)

    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: DOTENV_LANGUAGE_ID, filenames: ['.env'] })
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      DOTENV_LANGUAGE_ID,
      dotenvLanguageConfiguration
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      DOTENV_LANGUAGE_ID,
      dotenvMonarchLanguage
    )
  })

  it('is idempotent when the language already exists', () => {
    const monaco = createMonacoMock([DOTENV_LANGUAGE_ID])

    registerDotenvLanguage(monaco)

    expect(monaco.languages.register).not.toHaveBeenCalled()
    expect(monaco.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
  })
})

describe('dotenv tokenization', () => {
  it('colours comments, keys, the equals sign and values', () => {
    const [comment, assignment] = tokenizeDotenv('# Database\nDB_HOST=localhost')

    expect(tokenTypeAt(comment, 0)).toBe('comment')
    expect(tokenTypeAt(assignment, 0)).toBe('type.identifier')
    expect(tokenTypeAt(assignment, 7)).toBe('delimiter')
    expect(tokenTypeAt(assignment, 8)).toBe('string')
  })

  it('colours the export prefix', () => {
    const [line] = tokenizeDotenv('export API_KEY=abc')

    expect(tokenTypeAt(line, 0)).toBe('keyword')
    expect(tokenTypeAt(line, 7)).toBe('type.identifier')
    expect(tokenTypeAt(line, 15)).toBe('string')
  })

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

  it('keeps a # without leading space inside the value', () => {
    const [line] = tokenizeDotenv('COLOR=#fff')

    expect(tokenTypeAt(line, 6)).toBe('string')
  })

  it('ends an unquoted value at the end of its line', () => {
    const [, next] = tokenizeDotenv('A=1 2 3\nB=2')

    expect(tokenTypeAt(next, 0)).toBe('type.identifier')
  })

  it('lets a double-quoted value span lines, then resumes keys', () => {
    const [, middle, , after] = tokenizeDotenv('KEY="-----BEGIN\nMIIB==\n-----END"\nNEXT=1')

    expect(tokenTypeAt(middle, 0)).toBe('string')
    expect(tokenTypeAt(after, 0)).toBe('type.identifier')
  })

  it('treats a blank line after a value as a fresh line', () => {
    const [, , after] = tokenizeDotenv('A=1\n\n# note')

    expect(tokenTypeAt(after, 0)).toBe('comment')
  })
})
