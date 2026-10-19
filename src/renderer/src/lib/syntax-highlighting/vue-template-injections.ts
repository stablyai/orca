import type { LanguageRegistration } from 'shiki/core'

const CATALOGUE_VUE_SCOPE = 'source.vue'
const VUE_ROOT_SCOPE = 'text.html.vue'

/**
 * Vue's template grammars inject into `source.vue`, but Vue's root scope is
 * `text.html.vue`, so `{{ }}` and directive values would stay plain. They go in
 * the root grammar's own injections, which apply whatever loaded first.
 */
export function withVueTemplateInjections(
  grammars: readonly LanguageRegistration[]
): LanguageRegistration[] {
  const injections: NonNullable<LanguageRegistration['injections']> = {}
  for (const grammar of grammars) {
    if (grammar.injectTo?.includes(CATALOGUE_VUE_SCOPE) && grammar.injectionSelector) {
      injections[grammar.injectionSelector] = { patterns: [{ include: grammar.scopeName }] }
    }
  }
  return grammars.map((grammar) =>
    grammar.scopeName === VUE_ROOT_SCOPE && Object.keys(injections).length > 0
      ? { ...grammar, injections: { ...grammar.injections, ...injections } }
      : grammar
  )
}
