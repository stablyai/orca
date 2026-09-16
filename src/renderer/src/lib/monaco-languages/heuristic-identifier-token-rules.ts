// Shared Monarch tokenizer rules used to patch Monaco's syntactic (non-semantic)
// TS/JS highlighting so it distinguishes identifier *roles* the same way real
// semantic highlighting would — without standing up a semantic tokens provider.
// Used by both the real file/diff editors (register-function-call-highlighting.ts)
// and the Settings theme preview (register-theme-preview-language.ts) so the two
// stay visually consistent.
//
// Order matters: these must be tried, in this order, before the generic
// `[/[A-Z][\w$]*/, 'type.identifier']` catch-all rule every language already has.
//   1. FUNCTION_CALL_RULE       — any identifier immediately followed by '(' is a
//      call, function or method: `loadData(`, `test(`, `new Something(`.
//   2. ALL_CAPS_CONSTANT_RULE   — an identifier made entirely of uppercase
//      letters/digits/underscores (SCREAMING_SNAKE_CASE, `FICHE_..._FEATURES`,
//      `SCOPES`) is a constant/enum-member value, not a type — plain identifier
//      color, not the type-colored catch-all.
//   3. NAMESPACE_ACCESS_RULE    — a mixed-case Capitalized identifier
//      immediately followed by '.' (`FeatureFlags.X`, `SCOPES.Y` would already
//      be caught by rule 2 first) reads as a namespace/enum being accessed —
//      color it the same as a function call, not as a bare type reference.
export const FUNCTION_CALL_RULE: [RegExp, string] = [
  /[a-zA-Z_$][\w$]*(?=\s*\()/,
  'support.function'
]

export const ALL_CAPS_CONSTANT_RULE: [RegExp, string] = [
  /[A-Z][A-Z0-9_]*(?![a-zA-Z])/,
  'identifier'
]

export const NAMESPACE_ACCESS_RULE: [RegExp, string] = [
  /[A-Z][a-zA-Z0-9_$]*(?=\.)/,
  'support.function'
]

export const HEURISTIC_IDENTIFIER_TOKEN_RULES: [RegExp, string][] = [
  FUNCTION_CALL_RULE,
  ALL_CAPS_CONSTANT_RULE,
  NAMESPACE_ACCESS_RULE
]
