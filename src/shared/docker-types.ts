import type { SshTarget } from './ssh-types'

export type DockerConnectionKind = 'local' | 'ssh' | 'tcp'

export type DockerTcpConfig = {
  host: string
  port: number
  tls?: { caPath?: string; certPath?: string; keyPath?: string }
}

export type DockerConnection = {
  id: string
  label: string
  kind: DockerConnectionKind
  /** Set when kind === 'ssh'; references an existing SshTarget by id. */
  sshTargetId?: string
  /** Set when kind === 'tcp'. */
  tcp?: DockerTcpConfig
}

/** Built-in connection that targets the local daemon with zero configuration. */
export const LOCAL_DOCKER_CONNECTION_ID = 'local'

export const LOCAL_DOCKER_CONNECTION: DockerConnection = {
  id: LOCAL_DOCKER_CONNECTION_ID,
  label: 'Local',
  kind: 'local'
}

export type DockerContainerState =
  | 'created'
  | 'restarting'
  | 'running'
  | 'removing'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'unknown'

export type DockerContainerSummary = {
  id: string
  names: string[]
  image: string
  state: DockerContainerState
  status: string
  composeProject?: string
}

export type DockerConnectionStatus = 'unknown' | 'reachable' | 'unreachable'

/** Just the fields the SSH transport fallback needs from an SshTarget. */
export type DockerSshTargetRef = Pick<SshTarget, 'host' | 'port' | 'username'>

export type DockerResourcesChangedEvent = {
  connectionId: string
  containers: DockerContainerSummary[]
}
