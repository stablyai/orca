/**
 * Call inside a memo whose result holds translate() output. Passing the language through a call
 * keeps it a real memo input for React Compiler and exhaustive-deps; a bare `void language` does not.
 */
export function readUiLanguageMemoInput(language: string): string {
  return language
}
