/** A listing that fails reads as registered, so the host is still asked as before. */
export async function isRuntimeEnvironmentRegistered(environmentId: string): Promise<boolean> {
  try {
    const environments = await window.api.runtimeEnvironments.list()
    return environments.some((environment) => environment.id === environmentId)
  } catch {
    return true
  }
}
