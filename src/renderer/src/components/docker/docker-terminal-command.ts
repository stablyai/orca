import type { DockerConnection } from '../../../../shared/docker-types'

export type DockerTerminalKind = 'logs' | 'shell'

/**
 * Build the `{ command, connectionId }` for an embedded PTY.
 * local/tcp run as a local child (`connectionId: null`, `-H` added for tcp);
 * ssh runs `docker …` on the remote host via the relay (`connectionId` = the SshTarget id).
 * We spawn `sh` (not `bash`) — `sh` is present in virtually every image; `bash` is not (alpine).
 * This satisfies the design's documented "fall back to sh".
 */
export function buildDockerTerminalCommand(
  conn: DockerConnection,
  kind: DockerTerminalKind,
  containerId: string,
  dockerBinary = 'docker'
): { command: string; connectionId: string | null } {
  const base =
    conn.kind === 'tcp' && conn.tcp
      ? `${dockerBinary} -H tcp://${conn.tcp.host}:${conn.tcp.port}`
      : dockerBinary
  const inner =
    kind === 'logs' ? `logs -f --tail 1000 ${containerId}` : `exec -it ${containerId} sh`
  // clear wipes the host shell's echoed prompt/command line before docker takes over (POSIX/PowerShell; cmd.exe would need cls).
  return {
    command: `clear && ${base} ${inner}`,
    connectionId: conn.kind === 'ssh' ? (conn.sshTargetId ?? null) : null
  }
}
