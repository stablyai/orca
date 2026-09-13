import type { FindDefinitionsResponse, SymbolDef } from '../../../../shared/symbol-index'

export type GoToDefinitionOutcome =
  | { kind: 'open'; target: SymbolDef }
  | { kind: 'peek'; targets: SymbolDef[] }
  | { kind: 'fallback' }

export function resolveGoToDefinition(
  response: FindDefinitionsResponse,
  currentPath: string,
  currentLine: number
): GoToDefinitionOutcome {
  if (response.status !== 'ready' || response.definitions.length === 0) {
    return { kind: 'fallback' }
  }
  const defs = response.definitions
  if (defs.length === 1) {
    const only = defs[0]!
    if (only.path === currentPath && only.line === currentLine) {
      return { kind: 'fallback' }
    }
    return { kind: 'open', target: only }
  }
  return { kind: 'peek', targets: defs }
}
