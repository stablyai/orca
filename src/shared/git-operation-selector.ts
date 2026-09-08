export type GitOperationSelector =
  | { kind: 'named-remote'; value: string }
  | { kind: 'literal-url'; value: string }

// Git treats an unregistered selector as a URL/path, even when it matches a remote URL.
export function gitOperationSelector(
  value: string,
  remoteNames: readonly string[]
): GitOperationSelector {
  return {
    kind: remoteNames.includes(value) ? 'named-remote' : 'literal-url',
    value
  }
}
