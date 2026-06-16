import type { SshTarget } from './ssh-types'

export type DockerConnectionKind = 'local' | 'ssh' | 'tcp'

export type DockerTcpConfig = {
  host: string
  port: number
  // A boolean flag (maps to DOCKER_TLS_VERIFY) rather than cert paths: no UI
  // collects custom cert files, and the docker CLI reads them from ~/.docker.
  tls?: boolean
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
  /** com.docker.compose.service label, when the container is part of a compose project. */
  composeService?: string
}

export type DockerContainerMount = {
  type: string
  source: string
  destination: string
  mode: string
  rw: boolean
}

export type DockerContainerPortBinding = {
  /** e.g. '80/tcp' */
  containerPort: string
  /** Empty when the port is exposed but not published to the host. */
  hostIp: string
  hostPort: string
}

export type DockerContainerInspect = {
  id: string
  createdAt: string
  /** KEY=VALUE strings, verbatim from `.Config.Env`. */
  env: string[]
  mounts: DockerContainerMount[]
  ports: DockerContainerPortBinding[]
  /** `.HostConfig.RestartPolicy.Name`, e.g. 'no' | 'always' | 'unless-stopped' | 'on-failure'. */
  restartPolicy: string
}

export type DockerContainerAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'pause'
  | 'unpause'
  | 'remove'

export type DockerImageSummary = {
  id: string
  repository: string
  tag: string
  size: string
  createdSince: string
}

export type DockerVolumeSummary = {
  name: string
  driver: string
  scope: string
  mountpoint: string
}

export type DockerNetworkSummary = {
  id: string
  name: string
  driver: string
  scope: string
}

export type DockerResourceKind = 'container' | 'image' | 'volume' | 'network'

export type DockerResourceSelection = {
  kind: DockerResourceKind
  id: string
}

export type DockerConnectionStatus = 'unknown' | 'reachable' | 'unreachable'

/** Just the fields the SSH transport fallback needs from an SshTarget. */
export type DockerSshTargetRef = Pick<SshTarget, 'host' | 'port' | 'username'>

export type DockerResourcesChangedEvent = {
  connectionId: string
  containers: DockerContainerSummary[]
}
