import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shell/command-resolution/command-token-scanner'

// Clients that pass typed input on to a program elsewhere (a multiplexer pane, a remote host, a container).
const RELAY_CLIENT_NAMES = new Set([
  'tmux',
  'tmate',
  'screen',
  'zellij',
  'byobu',
  'dtach',
  'abduco',
  'ssh',
  'autossh',
  'mosh',
  'mosh-client',
  'et',
  'docker',
  'podman',
  'kubectl',
  'distrobox',
  'toolbox'
])

/** Whether the foreground program relays input to an agent Orca cannot see, so it proves no other program is reading it. */
export function isTerminalRelayClient(command: string): boolean {
  const name = getCommandTokenPathBasename(getFirstCommandToken(command))
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
  return RELAY_CLIENT_NAMES.has(name)
}
