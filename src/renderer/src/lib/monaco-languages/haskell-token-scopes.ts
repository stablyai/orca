/** Maps a TextMate scope stack to one Monaco token, preserving comment precedence. */
export function mapHaskellTokenScopes(scopes: readonly string[]): string {
  if (scopes.some((scope) => scope.startsWith('comment.'))) {
    return 'comment.haskell'
  }
  const scope = scopes.at(-1) ?? 'source.haskell'
  if (scope.startsWith('constant.numeric.')) {
    return 'number.haskell'
  }
  if (scope.startsWith('constant.character.escape.')) {
    return 'string.escape.haskell'
  }
  if (scope.startsWith('entity.name.function.')) {
    return 'entity.name.function.haskell'
  }
  if (scope.startsWith('storage.type.') || scope.startsWith('entity.name.namespace.')) {
    return 'keyword.haskell'
  }
  if (scope.startsWith('variable.other.generic-type.')) {
    return 'variable.parameter.haskell'
  }
  if (scope.startsWith('constant.other.') || scope.startsWith('constant.language.')) {
    return 'identifier.haskell'
  }
  if (scope.startsWith('keyword.operator.')) {
    return 'operator.haskell'
  }
  return scope
}

export const haskellFunctionThemeColors = {
  // Match VS Code's built-in Dark+/Light+ function declaration colors.
  'vs-dark': 'DCDCAA',
  vs: '795E26'
} as const
