export const GENERATED_AGENT_LAUNCH_ENV = 'ORCA_GENERATED_AGENT_LAUNCH'

export type GeneratedCmdLaunchInputs = {
  kind: 'cmd'
  executable: string
  args: string
  cwd: string | null
  codexHome?: string | null
  clearEnvNames?: readonly string[]
}

type GeneratedAgentLaunchInputs =
  | GeneratedCmdLaunchInputs
  | { kind: 'hermes-query'; argv: readonly string[] }

export function generatedAgentLaunchEnv(inputs: GeneratedCmdLaunchInputs): Record<string, string> {
  return { [GENERATED_AGENT_LAUNCH_ENV]: JSON.stringify(inputs) }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function readGeneratedAgentLaunchInputs(
  value: string | undefined
): GeneratedAgentLaunchInputs | undefined {
  if (!value) {
    return undefined
  }
  try {
    const inputs: unknown = JSON.parse(value)
    if (!isLaunchRecord(inputs)) {
      return undefined
    }
    if (inputs.kind === 'hermes-query' && isStringArray(inputs.argv)) {
      return { kind: inputs.kind, argv: inputs.argv }
    }
    if (
      inputs.kind === 'cmd' &&
      typeof inputs.executable === 'string' &&
      inputs.executable &&
      !/["\r\n\0]/.test(inputs.executable) &&
      typeof inputs.args === 'string' &&
      (!inputs.args || /^[ \t]/.test(inputs.args)) &&
      (inputs.cwd === null || typeof inputs.cwd === 'string') &&
      (inputs.codexHome == null || typeof inputs.codexHome === 'string') &&
      (inputs.clearEnvNames === undefined ||
        (isStringArray(inputs.clearEnvNames) &&
          inputs.clearEnvNames.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))))
    ) {
      return {
        kind: inputs.kind,
        executable: inputs.executable,
        args: inputs.args,
        cwd: inputs.cwd,
        codexHome: inputs.codexHome,
        clearEnvNames: inputs.clearEnvNames
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function isLaunchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
