import { describe, expect, it } from 'vitest'
import {
  tokenizeMonarchDocument,
  tokenLanguages,
  tokenLanguagesPerLine
} from './monarch-tokenizer-test-harness'
import { vueMonarchLanguage } from './register-vue'

// Use real Monarch tokenization; valid rule tables previously hid throws on every interpolation.
function tokenizeVue(source: string) {
  return tokenizeMonarchDocument('vue', vueMonarchLanguage, source)
}

/** Which languages actually cover each line — a dropped embed shows up as `vue`. */
function languagesPerLine(source: string): string[][] {
  return tokenLanguagesPerLine(tokenizeVue(source))
}

describe('vue tokenization', () => {
  // Template body must retain HTML before each interpolation or its pop rule throws.
  it('highlights every interpolation in a template line', () => {
    const [, line] = tokenizeVue('<template>\n  <p>{{ a }} and {{ b }}</p>\n</template>')

    expect(tokenLanguages(line)).toEqual([
      'html',
      'vue',
      'typescript',
      'vue',
      'html',
      'vue',
      'typescript',
      'vue',
      'html'
    ])
  })

  it('keeps the template embedded across a comment before it', () => {
    expect(languagesPerLine('<!-- a note -->\n<template>\n  <p>x</p>\n</template>')).toEqual([
      ['vue'],
      ['vue'],
      ['html'],
      ['vue']
    ])
  })

  it('does not enter typescript for an empty interpolation', () => {
    // Empty interpolation pushes no TypeScript; unwind state without popping a nonexistent embed.
    const [, line] = tokenizeVue('<template>\n  <p>{{}}</p>\n</template>')

    expect(tokenLanguages(line)).toEqual(['html', 'vue', 'html'])
  })
})

describe('vue embedded language attributes', () => {
  it.each([
    ['<script>', 'typescript'],
    ['<script lang="ts">', 'typescript'],
    ['<script setup lang="typescript">', 'typescript'],
    ['<script lang="js">', 'javascript'],
    ['<script setup lang=js>', 'javascript'],
    ['<script lang="unknown">', 'typescript']
  ])('embeds a %s body as %s', (openingTag, embeddedLanguageId) => {
    expect(languagesPerLine(`${openingTag}\n  a\n</script>`)).toEqual([
      ['vue'],
      [embeddedLanguageId],
      ['vue']
    ])
  })

  it.each([
    ['<style>', 'css'],
    ['<style scoped>', 'css'],
    ['<style lang="scss">', 'scss'],
    ["<style lang='sass'>", 'scss'],
    ['<style lang=less>', 'less'],
    ['<style lang="unknown">', 'css']
  ])('embeds a %s body as %s', (openingTag, embeddedLanguageId) => {
    expect(languagesPerLine(`${openingTag}\n  h1 { color: red; }\n</style>`)).toEqual([
      ['vue'],
      [embeddedLanguageId],
      ['vue']
    ])
  })
})
