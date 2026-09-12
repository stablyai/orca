import type { TuiAgentIdentityExclusion } from './tui-agent-config-types'

type SerializedRegExp = { source: string; flags: string }

/** JSON-safe form of TuiAgentIdentityExclusion so the SSH relay can run the same probe. */
export type SerializedIdentityExclusion = {
  args: readonly string[]
  excludePattern: SerializedRegExp
  requirePattern?: SerializedRegExp
}

export type IdentityProbeOutput = { stdout?: string | null; stderr?: string | null }

/**
 * Runs `command args` for one detected agent. Must reject when the probe could
 * not run or exited non-zero; the caller treats a rejection as "keep".
 */
export type IdentityProbe = (
  command: string,
  args: readonly string[]
) => Promise<IdentityProbeOutput>

export type IdentityExclusionCandidate = {
  id: string
  cmd: string
  identityExclusion?: SerializedIdentityExclusion
}

function serializeRegExp(pattern: RegExp): SerializedRegExp {
  return { source: pattern.source, flags: pattern.flags }
}

export function serializeIdentityExclusion(
  exclusion: TuiAgentIdentityExclusion
): SerializedIdentityExclusion {
  return {
    args: exclusion.args,
    excludePattern: serializeRegExp(exclusion.excludePattern),
    ...(exclusion.requirePattern
      ? { requirePattern: serializeRegExp(exclusion.requirePattern) }
      : {})
  }
}

export function identityProbeKeepsAgent(
  exclusion: SerializedIdentityExclusion,
  output: IdentityProbeOutput
): boolean {
  const text = `${output.stdout ?? ''}\n${output.stderr ?? ''}`
  const { excludePattern, requirePattern } = exclusion
  if (new RegExp(excludePattern.source, excludePattern.flags).test(text)) {
    return false
  }
  return requirePattern ? new RegExp(requirePattern.source, requirePattern.flags).test(text) : true
}

/**
 * Drops detected agents whose executable turned out to be an unrelated tool of
 * the same name. Only commands carrying an identityExclusion are probed, so
 * detection cost is unchanged for everyone else.
 */
export async function excludeMisidentifiedAgents(
  commands: readonly IdentityExclusionCandidate[],
  detected: readonly string[],
  foundCommands: ReadonlySet<string>,
  probe: IdentityProbe
): Promise<string[]> {
  const verdicts = await Promise.all(
    detected.map(async (id) => ({
      id,
      keep: await keepsDetectedAgent(commands, id, foundCommands, probe)
    }))
  )
  return verdicts.filter(({ keep }) => keep).map(({ id }) => id)
}

async function keepsDetectedAgent(
  commands: readonly IdentityExclusionCandidate[],
  id: string,
  foundCommands: ReadonlySet<string>,
  probe: IdentityProbe
): Promise<boolean> {
  const candidate = commands.find(
    (command) => command.id === id && command.identityExclusion && foundCommands.has(command.cmd)
  )
  if (!candidate?.identityExclusion) {
    return true
  }
  try {
    const output = await probe(candidate.cmd, candidate.identityExclusion.args)
    return identityProbeKeepsAgent(candidate.identityExclusion, output)
  } catch {
    // Why: a probe that cannot run says nothing about identity; hiding a real
    // install is worse than the collision this guards against.
    return true
  }
}
