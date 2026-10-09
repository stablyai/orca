import { classifyOpenCodeCliGeneration } from './opencode-cli-generation'
import type { OpenCodeCliGeneration } from './opencode-cli-generation'

const OPEN_CODE_V1_AGENT = 'opencode'
const OPEN_CODE_V2_AGENT = 'opencode2'

export type OpenCodeDetectionCommand = { id: string; cmd: string }

/**
 * Drop the v1 opencode id unless the shared binary is confirmed to be v1.
 *
 * The opencode v2 package ships both `opencode` and `opencode2` bins for the
 * same v2 binary, so a v2-only machine matches BOTH catalog entries when
 * detection is name-only (#24987). A genuine v1 install exposes only the v1
 * `opencode` id, so the ambiguous pair is the sole case that needs a probe.
 *
 * Only the ambiguous pair triggers `probeGeneration`; a single-id result is
 * returned untouched, which is what keeps the #9297 fs-only local path
 * spawn-free for every other machine. The probe affects ONLY the v1 id: the v2
 * id is never suppressed, because `opencode2` only exists in the v2 package and
 * dropping it could hide a genuine opencode2 in a mixed install. Probe `null`
 * means "could not tell", which is NOT proof of v1 — a v2-only machine is
 * exactly the reported false positive — so it suppresses the v1 id.
 */
export async function filterOpenCodeDetectedIds(
  detectedIds: readonly string[],
  probeGeneration: () => Promise<OpenCodeCliGeneration | null>
): Promise<string[]> {
  const hasV1 = detectedIds.includes(OPEN_CODE_V1_AGENT)
  const hasV2 = detectedIds.includes(OPEN_CODE_V2_AGENT)
  if (!hasV1 || !hasV2) {
    return [...detectedIds]
  }
  const generation = await probeGeneration()
  return generation === 'v1'
    ? [...detectedIds]
    : detectedIds.filter((id) => id !== OPEN_CODE_V1_AGENT)
}

/**
 * Relay variant: the relay has already resolved every command to a path, so it
 * classifies the ambiguous pair's generation from that path without a second
 * lookup. `probeVersion` returns raw `--version` output.
 */
export async function filterRelayOpenCodeDetectedIds(
  commands: readonly OpenCodeDetectionCommand[],
  detectedIds: readonly string[],
  executablePaths: ReadonlyMap<string, string | null>,
  probeVersion: (executablePath: string) => Promise<string | null>
): Promise<string[]> {
  // The v1 id is the shared `opencode` name; probing it answers the pair.
  const command = commands.find((entry) => entry.id === OPEN_CODE_V1_AGENT)
  return filterOpenCodeDetectedIds(detectedIds, async () => {
    if (!command) {
      return null
    }
    const output = await probeVersion(executablePaths.get(command.cmd) ?? '')
    return output ? classifyOpenCodeCliGeneration(output) : null
  })
}
