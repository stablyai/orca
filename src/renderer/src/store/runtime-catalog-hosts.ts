export async function listRuntimeEnvironmentsForAllHostLoad(): Promise<{ id: string }[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).environments
  } catch (err) {
    console.warn('Failed to list runtime environments for all-host load:', err)
    return []
  }
}
