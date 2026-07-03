#!/usr/bin/env node
/**
 * `orca-ide` bin for the npm server package. It keeps the public CLI shape
 * intact without claiming Linux's GNOME Orca `orca` command: `orca-ide serve`
 * starts the plain-Node server, and every other command is the normal RPC
 * client pointed at the runtime metadata under userData.
 */
import { runNodeServer } from '../main/server/node-server-main'
import type { ServeOrcaAppOptions } from '../cli/runtime/launch'
import { RuntimeClientError } from '../cli/runtime/types'

function nodeServerArgv(args: ServeOrcaAppOptions): string[] {
  if (args.recipeJson) {
    throw new RuntimeClientError(
      'unsupported_argument',
      '`orca-ide serve --recipe-json` is not supported by @stablyai/orca-server yet.'
    )
  }

  const argv: string[] = []
  if (args.json) {
    argv.push('--json')
  }
  if (args.port) {
    argv.push('--serve-port', args.port)
  }
  if (args.pairingAddress) {
    argv.push('--pairing-address', args.pairingAddress)
  }
  if (args.userDataPath) {
    argv.push('--user-data', args.userDataPath)
  }
  if (args.noPairing) {
    argv.push('--no-pairing')
  }
  if (args.mobilePairing) {
    argv.push('--mobile-pairing')
  }
  return argv
}

globalThis.__ORCA_NODE_SERVER_SERVE__ = async (args) => {
  await runNodeServer(nodeServerArgv(args))
  return 0
}

globalThis.__ORCA_CLI_DISABLE_AUTO_MAIN__ = true
process.env.ORCA_CLI_COMMAND_NAME ??= 'orca-ide'
void import('../cli/index')
  .then(({ main }) => main())
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
