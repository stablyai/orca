export type SemanticTokensLegend = { tokenTypes: string[]; tokenModifiers: string[] }

// Why: LSP 3.17 standard order; the renderer remaps every server legend onto it.
export const LSP_SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator'
]

export const LSP_SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary'
]

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isSemanticTokensLegend(value: unknown): value is SemanticTokensLegend {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tokenTypes' in value &&
    'tokenModifiers' in value &&
    isStringArray(value.tokenTypes) &&
    isStringArray(value.tokenModifiers)
  )
}
