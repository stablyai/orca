import { EXACT_NODE_ENTRYPOINT_IDENTITIES } from './agent-node-entrypoint-identities'
import { comparablePath } from './agent-command-line-entrypoint'

/** Only literal application arguments establish a capability; display command text never does. */
export function observedAgentInputMode(
  executable: string,
  argv: readonly string[],
  confirmedClaude: boolean
): 'noninteractive' | undefined {
  const path = comparablePath(executable)
  const name = path.split('/').at(-1)
  let index: number
  if (name === 'claude' || (confirmedClaude && /^\d+\.\d+\.\d+$/.test(name ?? ''))) {
    index = 1
  } else if (
    name === 'node' &&
    argv[1] &&
    EXACT_NODE_ENTRYPOINT_IDENTITIES.some(
      (entry) => entry.agent === 'claude' && entry.pattern.test(comparablePath(argv[1]))
    )
  ) {
    index = 2
  } else {
    return undefined
  }
  while (index < argv.length) {
    const argument = argv[index]
    if (argument === '--append-system-prompt' && index + 1 < argv.length) {
      index += 2
    } else if (argument.startsWith('--append-system-prompt=')) {
      index++
    } else {
      return argument === 'mcp' && argv[index + 1] === 'serve' ? 'noninteractive' : undefined
    }
  }
  return undefined
}
