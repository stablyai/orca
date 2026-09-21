import { describe, expect, it, vi } from 'vitest'
import {
  endEmbeddedLanguages,
  formatTokenizedLines,
  tokenizeMonarchDocument,
  tokenLanguages,
  tokenLanguagesPerLine
} from './monarch-tokenizer-test-harness'
import { registerVueLanguage, vueLanguageConfiguration, vueMonarchLanguage } from './register-vue'

// Driven through the real `MonarchTokenizer`: a rule-table walk cannot tell a
// working grammar from one that throws on every `{{ }}`, which is how broken
// Vue highlighting shipped green.
function tokenizeVue(source: string) {
  return tokenizeMonarchDocument('vue', vueMonarchLanguage, source)
}

/** Which languages actually cover each line — a dropped embed shows up as `vue`. */
function languagesPerLine(source: string): string[][] {
  return tokenLanguagesPerLine(tokenizeVue(source))
}

describe('registerVueLanguage registration', () => {
  // Structural by necessity: covers the registration call itself (ids,
  // extensions, idempotence), which tokenizing cannot observe.
  it('registers the vue language, Monarch tokenizer, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'typescript' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const getLanguages = vi.fn(() => languages)
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages
      }
    }

    registerVueLanguage(monacoMock as never)
    registerVueLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'vue',
      extensions: ['.vue'],
      aliases: ['Vue']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('vue', vueMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('vue', vueLanguageConfiguration)
  })
})

describe('vue tokenization', () => {
  it('tokenizes a representative SFC', () => {
    const fixture = `<template>
  <p>{{ message.toUpperCase() }}</p>
</template>

<script setup lang="ts">
const message = 'hello'
</script>

<style scoped>
p { color: rebeccapurple; }
</style>`

    expect(formatTokenizedLines(tokenizeVue(fixture))).toMatchInlineSnapshot(`
      [
        "<template> | 0:tag.vue@vue | embed=html",
        "  <p>{{ message.toUpperCase() }}</p> | 0:-@html 5:delimiter.curly.vue@vue 7:-@typescript 30:delimiter.curly.vue@vue 32:-@html | embed=html",
        "</template> | 0:tag.vue@vue | embed=none",
        " |  | embed=none",
        "<script setup lang="ts"> | 0:tag.vue@vue 7:white.vue@vue 8:attribute.name.vue@vue 13:white.vue@vue 14:attribute.name.vue@vue 18:delimiter.vue@vue 19:attribute.value.vue@vue 23:tag.vue@vue | embed=typescript",
        "const message = 'hello' | 0:-@typescript | embed=typescript",
        "</script> | 0:tag.vue@vue | embed=none",
        " |  | embed=none",
        "<style scoped> | 0:tag.vue@vue 6:white.vue@vue 7:attribute.name.vue@vue 13:tag.vue@vue | embed=css",
        "p { color: rebeccapurple; } | 0:-@css | embed=css",
        "</style> | 0:tag.vue@vue | embed=none",
      ]
    `)
  })

  // Regression: every `{{ }}` threw "cannot pop embedded language if not inside
  // one" once the template body lost its html embed.
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

  it('embeds the template body as html', () => {
    expect(endEmbeddedLanguages(tokenizeVue('<template>\n  <p>x</p>\n</template>'))).toEqual([
      'html',
      'html',
      null
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
    // `{{}}` pops html on entry but never pushes typescript; the close must
    // unwind only the state, or it pops an embed that is not there.
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

describe('vue root state invariant', () => {
  // Structural on purpose: behaviour can only reach the root rules some fixture
  // happens to exercise, and a root rule that pops an embed throws on the very
  // first character of a file. Guard every root rule, exercised or not.
  it('has no root rule that pops an embedded language', () => {
    const rootRules = (vueMonarchLanguage.tokenizer as Record<string, unknown[]>).root
    const popRules = rootRules.filter(
      (rule) =>
        Array.isArray(rule) && (rule[1] as { nextEmbedded?: string })?.nextEmbedded === '@pop'
    )

    expect(popRules).toEqual([])
  })
})
