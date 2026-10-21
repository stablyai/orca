// Why: Monaco's stock TS/JS grammar tokenizes primitive types and literal constants as plain
// keywords, and declared type names like any other type reference. Themes such as Monokai color
// these roles differently (cyan primitives, purple literals, green declarations), so tag them.
// Must run before the heuristic identifier rules, or `class API` would hit the ALL_CAPS rule.

export const PRIMITIVE_TYPE_RULE: [RegExp, string] = [
  // Not followed by `(` or `.`: `z.string()` and `symbol.description` stay calls/values.
  /(?:string|number|boolean|bigint|symbol|any|unknown|never)(?![\w$])(?!\s*[(.])/,
  'type'
]

export const LITERAL_CONSTANT_RULE: [RegExp, string] = [
  /(?:null|undefined|true|false)(?![\w$])/,
  'constant.language'
]

export const TYPE_DECLARATION_RULE: [RegExp, string[]] = [
  /(class|interface|enum|type)(\s+)(?!(?:extends|implements)(?![\w$]))([a-zA-Z_$][\w$]*)/,
  ['keyword', '', 'type.declaration']
]

export const TYPE_ROLE_TOKEN_RULES: [RegExp, string | string[]][] = [
  TYPE_DECLARATION_RULE,
  PRIMITIVE_TYPE_RULE,
  LITERAL_CONSTANT_RULE
]
