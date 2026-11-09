import type { LanguageRegistration } from 'shiki/core'

const CATALOGUE_VUE_SCOPE = 'source.vue'
const VUE_ROOT_SCOPE = 'text.html.vue'

// Vue injections target source.vue but root uses text.html.vue; install root-local injections so template expressions/directives color regardless of load order.
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
