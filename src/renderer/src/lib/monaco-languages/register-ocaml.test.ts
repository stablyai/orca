import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  OCAML_LANGUAGE_ID,
  OCAML_MLX_LANGUAGE_ID,
  OCAML_MLX_TEXTMATE_SCOPE,
  OCAML_TEXTMATE_SCOPE,
  loadOcamlTextMateGrammar,
  ocamlLanguageConfiguration,
  registerOcamlLanguage,
  registerOcamlMlxLanguage
} from './register-ocaml'
import { createFixtureQueries, tokenizeFixture } from './textmate-fixture-tokenizer'
import type { TokenizedFixture } from './textmate-fixture-tokenizer'

function tokenizeOcamlFixture(
  fixtureName: string,
  scopeName = OCAML_TEXTMATE_SCOPE
): Promise<TokenizedFixture> {
  return tokenizeFixture({
    fixtureDir: join(import.meta.dirname, '__fixtures__'),
    fixtureName,
    scopeName,
    loadGrammar: loadOcamlTextMateGrammar,
    trailingLine: 'let after = 1'
  })
}

function createMonacoMock() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerOcamlLanguage', () => {
  it('maps OCaml extensions to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    registerOcamlLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: OCAML_LANGUAGE_ID,
      extensions: ['.ml', '.mli'],
      filenames: ['.ocamlinit'],
      aliases: ['OCaml', 'ocaml']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      OCAML_LANGUAGE_ID,
      ocamlLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      OCAML_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('ocamlLanguageConfiguration', () => {
  it('declares only a block comment because OCaml has no line comment', () => {
    expect(ocamlLanguageConfiguration.comments).toEqual({ blockComment: ['(*', '*)'] })
  })

  it('never auto-closes or surrounds with a single quote, which opens type variables', () => {
    expect(ocamlLanguageConfiguration.autoClosingPairs).not.toContainEqual(
      expect.objectContaining({ open: "'" })
    )
    expect(ocamlLanguageConfiguration.surroundingPairs).not.toContainEqual(
      expect.objectContaining({ open: "'" })
    )
  })

  it('keeps primed identifiers and type variables as single words', () => {
    const wordPattern = ocamlLanguageConfiguration.wordPattern!

    expect("let loop' x = x".match(wordPattern)).toEqual(['let', "loop'", 'x', 'x'])
    expect("'a".match(wordPattern)).toEqual(["'a"])
    // Why: `$` is a Monaco default separator and a symbolic OCaml operator;
    // outside the separator class it would join `x$y` into one word.
    expect('x$y'.match(wordPattern)).toEqual(['x', 'y'])
  })
})

describe('loadOcamlTextMateGrammar', () => {
  it('loads the vendored OCaml grammar for the OCaml scope', async () => {
    const grammar = await loadOcamlTextMateGrammar(OCAML_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({ name: 'OCaml', scopeName: OCAML_TEXTMATE_SCOPE })
  })

  it('serves the interface grammar that the OCaml grammar includes', async () => {
    // Why: `source.ocaml` includes it for `sig ... end` bodies, so a loader that
    // only answered for `source.ocaml` would drop signature scopes.
    await expect(loadOcamlTextMateGrammar('source.ocaml.interface')).resolves.toMatchObject({
      scopeName: 'source.ocaml.interface'
    })
  })

  it('deliberately does not serve the ocamldoc markup grammar', async () => {
    await expect(loadOcamlTextMateGrammar('source.ocaml.ocamldoc')).resolves.toBeNull()
  })

  it('ignores unrelated and inherited-property scopes', async () => {
    await expect(loadOcamlTextMateGrammar('source.python')).resolves.toBeNull()
    await expect(loadOcamlTextMateGrammar('constructor')).resolves.toBeNull()
  })
})

describe('OCaml tokenization', () => {
  let fixture: TokenizedFixture
  let scopesOf: ReturnType<typeof createFixtureQueries>['scopesOf']
  let scopeOnLine: ReturnType<typeof createFixtureQueries>['scopeOnLine']

  beforeAll(async () => {
    fixture = await tokenizeOcamlFixture('ocaml-syntax-traps.ml')
    ;({ scopesOf, scopeOnLine } = createFixtureQueries(fixture))
  })

  it('keeps nested comments inside the comment scope and closes them', () => {
    expect(new Set(scopesOf('innermost'))).toEqual(new Set(['comment.block.ocaml']))
    expect(scopeOnLine('(**)', '(**)')).toBe('comment.block.ocaml')
  })

  it('keeps doc comments uniformly comment-scoped', () => {
    // Why: with `source.ocaml.ocamldoc` unserved, doc bodies stay comment-coloured.
    expect(new Set(scopesOf('{b markup}'))).toEqual(new Set(['comment.doc.ocaml']))
  })

  it('does not leak tokenizer state on an unbalanced bracket in inline code', () => {
    expect(new Set(scopesOf('equivalent to'))).toEqual(new Set(['comment.doc.ocaml']))
    expect(scopeOnLine('let id :', 'let')).toBe('keyword.ocaml')
  })

  it('treats a type variable as a type and only a closed form as a character', () => {
    expect(scopeOnLine('let id :', "'a")).toBe('storage.type.ocaml')
    expect(scopeOnLine('let plain', "'x'")).toBe('string.quoted.single.ocaml')
  })

  it('scopes string escapes and a backslash line continuation', () => {
    expect(scopesOf('let escaped')).toContain('constant.character.escape.ocaml')
    // The line after the continuation is still inside the same string.
    expect(scopesOf('let continued', 1)).toContain('string.quoted.double.ocaml')
  })

  it('closes quoted string literals on their own delimiter id', () => {
    expect(scopeOnLine('let raw', '{|')).toBe('string.quoted.braced.ocaml')
    expect(scopeOnLine('let raw', '|}')).toBe('string.quoted.braced.ocaml')
    // A custom delimiter must close on `|sql}` and not on a bare `|}`.
    expect(scopeOnLine('let tagged', '{sql|')).toBe('string.quoted.braced.ocaml')
    expect(scopeOnLine('let tagged', '|sql}')).toBe('string.quoted.braced.ocaml')
    expect(scopeOnLine('let nested_delim', '|ext}')).toBe('string.quoted.braced.ocaml')
  })

  it('scopes polymorphic variants, labelled arguments and capitalised identifiers', () => {
    expect(scopeOnLine('type status', '`Pending')).toBe(
      'constant.language.polymorphic-variant.ocaml'
    )
    expect(scopesOf('let render')).toContain('variable.parameter.labeled.ocaml')
    expect(scopesOf('let render')).toContain('variable.parameter.optional.ocaml')
    expect(scopeOnLine('let%lwt', 'Lwt')).toBe('constant.language.capital-identifier.ocaml')
  })

  it('scopes attributes and PPX extensions', () => {
    expect(scopeOnLine('@@deriving', '@@')).toBe('keyword.operator.attribute.ocaml')
    expect(scopeOnLine('@@deriving', 'deriving')).toBe('keyword.other.attribute.ocaml')
    expect(scopeOnLine('@@@warning', '@@@')).toBe('keyword.operator.attribute.ocaml')
    expect(scopesOf('let expanded')).toContain('keyword.operator.extension.ocaml')
  })

  it('scopes keyword operators and user-defined symbolic operators', () => {
    for (const keywordOperator of ['land', 'lor', 'lxor', 'lsl', 'lsr', 'asr']) {
      expect(scopeOnLine('let bits', keywordOperator)).toBe('keyword.operator.ocaml')
    }
    expect(scopeOnLine('let modulo', 'mod')).toBe('keyword.operator.ocaml')
    expect(scopeOnLine('let ( +| )', '+|')).toBe('keyword.operator.ocaml')
    expect(scopeOnLine('let ( >>= )', '>>=')).toBe('keyword.operator.ocaml')
  })

  it('scopes every numeric literal form', () => {
    expect(scopeOnLine('let million', '1_000_000')).toBe('constant.numeric.decimal.integer.ocaml')
    expect(scopeOnLine('let hexa', '0xDEAD_BEEF')).toBe(
      'constant.numeric.hexadecimal.integer.ocaml'
    )
    expect(scopeOnLine('let octa =', '0o755')).toBe('constant.numeric.octal.integer.ocaml')
    expect(scopeOnLine('let bina', '0b1010_1010')).toBe('constant.numeric.binary.integer.ocaml')
    expect(scopeOnLine('let trailing_dot', '1.')).toBe('constant.numeric.decimal.float.ocaml')
    expect(scopeOnLine('let exponent', '1.5e-3')).toBe('constant.numeric.decimal.float.ocaml')
    expect(scopeOnLine('let hex_float', '0x1.8p3')).toBe('constant.numeric.hexadecimal.float.ocaml')
    expect(scopeOnLine('let int32', '42l')).toBe('constant.numeric.decimal.integer.ocaml')
    expect(scopeOnLine('let int64', '42L')).toBe('constant.numeric.decimal.integer.ocaml')
    expect(scopeOnLine('let native', '42n')).toBe('constant.numeric.decimal.integer.ocaml')
  })

  it('leaves no comment or string state open at the end of the fixture', () => {
    // Why: an unclosed nested comment or a character-literal misfire colours
    // every line after it.
    expect(fixture.trailingScopes[0]).toBe('keyword.ocaml')
    expect(fixture.trailingScopes).not.toContain('comment.block.ocaml')
    expect(fixture.trailingScopes).not.toContain('string.quoted.single.ocaml')
  })
})

describe('OCaml signature tokenization', () => {
  // Why: `.mli` tokenizes under `source.ocaml`, which reaches the interface
  // rules only through its `source.ocaml.interface#bindings` include.
  let fixture: TokenizedFixture
  let uniqueScopeOf: ReturnType<typeof createFixtureQueries>['uniqueScopeOf']

  beforeAll(async () => {
    fixture = await tokenizeOcamlFixture('ocaml-signature-traps.mli')
    ;({ uniqueScopeOf } = createFixtureQueries(fixture))
  })

  it('scopes signature-only binding keywords and the names they bind', () => {
    for (const keyword of ['val', 'external', 'method']) {
      expect(uniqueScopeOf(keyword)).toBe('keyword.ocaml')
    }
    for (const bound of ['empty', 'identity', 'to_string', 'compare']) {
      expect(uniqueScopeOf(bound)).toBe('entity.name.function.binding.ocaml')
    }
    expect(uniqueScopeOf('sig')).toBe('keyword.other.ocaml')
    expect(uniqueScopeOf('end')).toBe('keyword.other.ocaml')
  })

  it('reads a type variable in a signature as a type, not a character literal', () => {
    expect(uniqueScopeOf("'acc")).toBe('storage.type.ocaml')
  })

  it('never emits the .interface scope suffix that a second registration would', () => {
    // Why: the scopes are the implementation grammar's, which stock Monaco
    // themes match.
    expect(fixture.allTokens.filter((token) => token.scope.endsWith('.interface'))).toEqual([])
  })

  it('leaves no comment state open after a trailing doc comment', () => {
    expect(fixture.trailingScopes[0]).toBe('keyword.ocaml')
    expect(fixture.trailingScopes).not.toContain('comment.doc.ocaml')
  })
})

describe('registerOcamlMlxLanguage', () => {
  it('registers .mlx as its own language id sharing the OCaml configuration', () => {
    const monaco = createMonacoMock()

    registerOcamlMlxLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: OCAML_MLX_LANGUAGE_ID,
      extensions: ['.mlx'],
      aliases: ['OCaml.mlx', 'ocaml.mlx']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      OCAML_MLX_LANGUAGE_ID,
      ocamlLanguageConfiguration
    )
  })

  it('serves the MLX grammar for its own scope', async () => {
    await expect(loadOcamlTextMateGrammar(OCAML_MLX_TEXTMATE_SCOPE)).resolves.toMatchObject({
      name: 'OCaml.mlx',
      scopeName: OCAML_MLX_TEXTMATE_SCOPE
    })
  })
})

describe('MLX tokenization', () => {
  let fixture: TokenizedFixture
  let scopeOnLine: ReturnType<typeof createFixtureQueries>['scopeOnLine']

  beforeAll(async () => {
    fixture = await tokenizeOcamlFixture('ocaml-mlx-syntax-traps.mlx', OCAML_MLX_TEXTMATE_SCOPE)
    ;({ scopeOnLine } = createFixtureQueries(fixture))
  })

  it('scopes tag delimiters, names and attributes as markup', () => {
    expect(scopeOnLine('let plain', '<')).toBe('punctuation.definition.tag.begin.js')
    expect(scopeOnLine('let plain', '>')).toBe('punctuation.definition.tag.end.js')
    expect(scopeOnLine('let plain', '</')).toBe('punctuation.definition.tag.begin.js')
    expect(scopeOnLine('let plain', 'div')).toBe('entity.name.tag.inline.any.html')
    expect(scopeOnLine('let plain', 'className')).toBe('entity.other.attribute-name.namespace.js')
    expect(scopeOnLine('let self_closing', '/>')).toBe('punctuation.definition.tag.end.js')
  })

  it('keeps OCaml scopes for expressions embedded in braces', () => {
    expect(scopeOnLine('let plain', 'React')).toBe('constant.language.capital-identifier.ocaml')
    expect(scopeOnLine('let capitalised', 'fun')).toBe('keyword.other.ocaml')
    expect(scopeOnLine('let capitalised', 'true')).toBe('constant.language.boolean.ocaml')
    expect(scopeOnLine('let plain', 'card')).toBe('string.quoted.double.ocaml')
  })

  it('reads a real comparison as an operator rather than opening a tag', () => {
    // Why: `<` and `>` are OCaml operators, so the grammar must not treat every
    // one of them as markup — that would swallow the rest of the file.
    expect(scopeOnLine('let compared', '<')).toBe('keyword.operator.ocaml')
    expect(scopeOnLine('let compared', '>')).toBe('keyword.operator.ocaml')
  })

  it('leaves no markup or comment state open at the end of the fixture', () => {
    expect(fixture.trailingScopes[0]).toBe('keyword.ocaml')
    expect(fixture.trailingScopes.join(',')).not.toContain('tag')
  })
})
