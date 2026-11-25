export const verifiedPartitionByRoute = new Map<string, string>()

export function sshWorkspaceBrowserRouteKey(
  targetId: string | null,
  browserProfileId: string,
  expectedSshTargetGeneration: number | undefined,
  skipProbe: boolean
): string {
  return JSON.stringify([
    targetId,
    browserProfileId,
    expectedSshTargetGeneration ?? null,
    skipProbe
  ])
}
