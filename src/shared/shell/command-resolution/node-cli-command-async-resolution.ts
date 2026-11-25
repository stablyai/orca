import { runCliFsReadsAsync } from './cli-fs-reads'
import {
  cliCommandLookup,
  cliRuntimePathPairing,
  executableCommandLookup,
  type ResolveCommandOptions
} from './node-cli-command-resolution'

/** resolveCliCommand with every filesystem read off the event loop. */
export function resolveCliCommandAsync(
  commandName: string,
  options: ResolveCommandOptions = {}
): Promise<string> {
  return runCliFsReadsAsync(cliCommandLookup(commandName, options))
}

/** resolveExecutableCommand with every filesystem read off the event loop. */
export function resolveExecutableCommandAsync(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<string | null> {
  return runCliFsReadsAsync(executableCommandLookup(command, options))
}

/** withCliRuntimeOnPath with every filesystem read off the event loop. */
export function withCliRuntimeOnPathAsync<T extends NodeJS.ProcessEnv>(
  commandPath: string,
  env: T,
  options: Pick<ResolveCommandOptions, 'platform'> = {}
): Promise<T> {
  return runCliFsReadsAsync(cliRuntimePathPairing(commandPath, env, options))
}
