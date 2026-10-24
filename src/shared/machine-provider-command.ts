import { z } from 'zod'
import { isRuntimePathAbsolute } from './cross-platform-path'
import { pluginRelativePathError } from './plugins/plugin-path-safety'

/** Runs Orca's own executable as node, so providers never depend on a `node` on PATH. */
export const MACHINE_PROVIDER_ORCA_NODE = '$orca-node'
/** Prefix for a path contained in the contributing plugin's root. */
export const MACHINE_PROVIDER_PLUGIN_PATH_PREFIX = '$plugin/'

// Why so narrow: ssh re-joins argv into a remote shell line, so the id is the only
// dynamic argv value and must carry no shell metacharacters.
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const MACHINE_PROVIDER_VERBS = [
  'capabilities',
  'list',
  'get',
  'create',
  'sleep',
  'wake',
  'archive',
  'delete'
] as const
export type MachineProviderVerb = (typeof MACHINE_PROVIDER_VERBS)[number]

const TARGETED_VERBS: ReadonlySet<MachineProviderVerb> = new Set([
  'get',
  'sleep',
  'wake',
  'archive',
  'delete'
])

export function isTargetedMachineProviderVerb(verb: MachineProviderVerb): boolean {
  return TARGETED_VERBS.has(verb)
}

function programError(program: string): string | null {
  if (program === MACHINE_PROVIDER_ORCA_NODE) {
    return null
  }
  if (program.startsWith(MACHINE_PROVIDER_PLUGIN_PATH_PREFIX)) {
    return pluginPathArgumentError(program)
  }
  if (isRuntimePathAbsolute(program, 'posix') || isRuntimePathAbsolute(program, 'windows')) {
    return null
  }
  // A relative path would resolve against whatever cwd spawns it.
  return /[\\/]/.test(program)
    ? `"${program}" must be a bare command name, an absolute path, ${MACHINE_PROVIDER_ORCA_NODE}, or ${MACHINE_PROVIDER_PLUGIN_PATH_PREFIX}<path>`
    : null
}

function pluginPathArgumentError(value: string): string | null {
  const error = pluginRelativePathError(value.slice(MACHINE_PROVIDER_PLUGIN_PATH_PREFIX.length))
  return error ? `"${value}" ${error}` : null
}

export const machineProviderCommandSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0'), 'must not contain NUL bytes')
  )
  .min(1)
  .max(64)
  .superRefine((command, ctx) => {
    command.forEach((value, index) => {
      const error =
        index === 0
          ? programError(value)
          : value === MACHINE_PROVIDER_ORCA_NODE
            ? `${MACHINE_PROVIDER_ORCA_NODE} is only allowed as the program`
            : value.startsWith(MACHINE_PROVIDER_PLUGIN_PATH_PREFIX)
              ? pluginPathArgumentError(value)
              : null
      if (error) {
        ctx.addIssue({ code: 'custom', path: [index], message: error })
      }
    })
  })

// Why quote every argument: argv runs without a shell, so word boundaries must be unambiguous.
export function formatMachineProviderArgv(argv: readonly string[]): string {
  return argv.map((value) => JSON.stringify(value)).join(' ')
}

/** Appends `<verb> --json [--id <machineId>]`; everything else travels on stdin. */
export function buildMachineProviderArgv(
  command: readonly string[],
  verb: MachineProviderVerb,
  machineId?: string
): string[] {
  if (isTargetedMachineProviderVerb(verb)) {
    if (machineId === undefined || !MACHINE_ID_PATTERN.test(machineId)) {
      throw new Error(`Invalid machine id for ${verb}.`)
    }
    return [...command, verb, '--json', '--id', machineId]
  }
  if (machineId !== undefined) {
    throw new Error(`${verb} does not take a machine id.`)
  }
  return [...command, verb, '--json']
}
