// The normalized FULL semantic-token legend the client declares in initialize
// (spike findings §1). clangd returns its OWN legend (names differ from LSP
// standard — e.g. `method` not `function.member`, 24 types incl. self-invented
// `unknown`/`bracket`/`label`), so decoding/re-encoding is BY NAME against this
// set: a name absent from here is skipped and the Monarch lexical layer colors
// the identifier. Lives in `shared` so the main process (capability declaration
// + by-name decode) and the renderer (by-name re-encode + provider legend) use
// one source of truth.

/** Identifier-class token types (first 5+ cover the acceptance criteria colors).
 *  Mirrors the names clangd actually emits (it distinguishes `enum` from
 *  `enumMember`, and returns `typeParameter`/`operator`/`comment` too) so the
 *  by-name decode/re-encode matches them instead of routing the enum-type
 *  identifiers (e.g. `ADAPTER_TYPE`) to NO_STYLING (grey). */
export const SEMANTIC_TOKEN_CLIENT_TYPES: readonly string[] = [
  'namespace',
  'type',
  'class',
  'enum',
  'enumMember',
  'function',
  'variable',
  'macro',
  'parameter',
  'property',
  'method',
  'typeParameter'
]

export const SEMANTIC_TOKEN_CLIENT_MODIFIERS: readonly string[] = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'globalScope',
  'classScope'
]
