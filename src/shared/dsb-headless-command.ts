import {
  comparablePath,
  findInterpreterEntrypointToken,
  isInterpreterProcessName
} from './agent-command-line-entrypoint'

function isDsbScriptEntrypoint(token: string): boolean {
  const base = token.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    base === 'dsb.js' || base === 'dsb.mjs' || base === 'dsb.cjs' || base === 'deepseek-build.js'
  )
}

// Why: `dsb run` exits after one message; Node preload arguments precede the npm shim.
export function isDsbHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  const command =
    comparablePath(tokens[0] ?? '')
      .split('/')
      .pop()
      ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '') ?? ''
  let commandIndex = 0
  if (isInterpreterProcessName(command)) {
    const entrypoint = findInterpreterEntrypointToken([...tokens], command)
    if (!entrypoint || !isDsbScriptEntrypoint(entrypoint)) {
      return false
    }
    commandIndex = tokens.indexOf(entrypoint, 1)
  }
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token === '--') {
      return false
    }
    if (token.startsWith('-')) {
      continue
    }
    return token === 'run'
  }
  return false
}
