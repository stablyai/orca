const runtimeIdsByEnvironment = new Map<string, string | null>()

export function noteWorkspaceWindowRuntimeEnvironment(
  environmentId: string,
  runtimeId: string | null
): void {
  if (typeof window !== 'undefined' && window.orcaWorkspaceWindowNative) {
    runtimeIdsByEnvironment.set(environmentId, runtimeId)
  }
}

export function isLocalWorkspaceWindowEnvironment(environmentId: string): boolean {
  const localRuntimeId =
    typeof window !== 'undefined' ? window.orcaWorkspaceWindowNative?.localRuntimeId : null
  return Boolean(localRuntimeId && runtimeIdsByEnvironment.get(environmentId) === localRuntimeId)
}
