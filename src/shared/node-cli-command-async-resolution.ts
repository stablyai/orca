import { runCliFsReadsAsync } from './cli-fs-reads'
import { cliCommandLookup, type ResolveCommandOptions } from './node-cli-command-resolution'

/** resolveCliCommand with every filesystem read off the event loop. */
export function resolveCliCommandAsync(
  commandName: string,
  options: ResolveCommandOptions = {}
): Promise<string> {
  return runCliFsReadsAsync(cliCommandLookup(commandName, options))
}
