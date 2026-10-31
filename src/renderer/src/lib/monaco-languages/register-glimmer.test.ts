import { describe, expect, it, vi } from 'vitest'
import { formatTokenizedLines, tokenizeMonarchDocument } from './monarch-tokenizer-test-harness'
import {
  glimmerJsMonarchLanguage,
  glimmerLanguageConfiguration,
  glimmerTsMonarchLanguage,
  registerGlimmerLanguages
} from './register-glimmer'

describe('registerGlimmerLanguages', () => {
  // Tokenizing cannot observe registration IDs/extensions/idempotence; structural checks cover that contract.
  it('registers both Glimmer languages, tokenizers, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'typescript' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages: () => languages
      }
    }

    registerGlimmerLanguages(monacoMock)
    registerGlimmerLanguages(monacoMock)

    expect(register.mock.calls).toEqual([
      [{ id: 'glimmer-ts', extensions: ['.gts'], aliases: ['Glimmer TS'] }],
      [{ id: 'glimmer-js', extensions: ['.gjs'], aliases: ['Glimmer JS'] }]
    ])
    expect(setMonarchTokensProvider.mock.calls).toEqual([
      ['glimmer-ts', glimmerTsMonarchLanguage],
      ['glimmer-js', glimmerJsMonarchLanguage]
    ])
    expect(setLanguageConfiguration.mock.calls).toEqual([
      ['glimmer-ts', glimmerLanguageConfiguration],
      ['glimmer-js', glimmerLanguageConfiguration]
    ])
  })
})

describe('glimmer tokenization', () => {
  // Real Monarch tokenization: an embed popped without a matching push throws per line and drops highlighting.
  it('alternates the script embed with Handlebars template islands', () => {
    const fixture = `import Component from '@glimmer/component'
export default class Hello extends Component<Signature> {
  <template>
    <p>Hello {{this.name}}</p>
  </template>
}
const Inline = <template>{{@a}}</template>; const Empty = <template></template>;`

    expect(
      formatTokenizedLines(tokenizeMonarchDocument('glimmer-ts', glimmerTsMonarchLanguage, fixture))
    ).toMatchInlineSnapshot(`
      [
        "import Component from '@glimmer/component' | 0:-@typescript | embed=typescript",
        "export default class Hello extends Component<Signature> { | 0:-@typescript | embed=typescript",
        "  <template> | 0:-@typescript 2:tag.gts@glimmer-ts | embed=none",
        "    <p>Hello {{this.name}}</p> | 0:-@handlebars | embed=handlebars",
        "  </template> | 0:-@handlebars 2:tag.gts@glimmer-ts | embed=none",
        "} | 0:-@typescript | embed=typescript",
        "const Inline = <template>{{@a}}</template>; const Empty = <template></template>; | 0:-@typescript 15:tag.gts@glimmer-ts 25:-@handlebars 31:tag.gts@glimmer-ts 42:-@typescript 58:tag.gts@glimmer-ts 79:-@typescript | embed=typescript",
      ]
    `)
  })

  it('starts a template-only component in Handlebars and uses the javascript embed for .gjs', () => {
    const fixture = `<template>
  <h1>{{@title}}</h1>
</template>
export const x = 1`

    expect(
      formatTokenizedLines(tokenizeMonarchDocument('glimmer-js', glimmerJsMonarchLanguage, fixture))
    ).toMatchInlineSnapshot(`
      [
        "<template> | 0:tag.gjs@glimmer-js | embed=none",
        "  <h1>{{@title}}</h1> | 0:-@handlebars | embed=handlebars",
        "</template> | 0:tag.gjs@glimmer-js | embed=none",
        "export const x = 1 | 0:-@javascript | embed=javascript",
      ]
    `)
  })
})
