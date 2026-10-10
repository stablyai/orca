/**
 * The real SSH host a conversion cell runs against: the Linux Docker fixture, or a Windows
 * OpenSSH host the ssh-windows-hosts lane provisioned and described in a descriptor file.
 */
import { readFileSync } from 'node:fs'
import type { TestInfo } from '@stablyai/playwright-test'
import type { SshTargetCreateInput } from '../../../src/shared/ssh-types'
import { parseWindowsHostCellDescriptor } from '../../../src/main/ssh/ssh-windows-host-cells'
import {
  blockDockerSshRelayTargetTcpForwarding,
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget
} from './docker-ssh-relay-target'

export const ORCAD_CONVERT_HOST_ENV = 'ORCA_E2E_ORCAD_CONVERT_HOST'

export type OrcadConvertHost = {
  input: SshTargetCreateInput
  /** A git repository that already exists on the host. */
  remoteRepoPath: string
  /** An existing remote directory the cell opens as a folder workspace. */
  remoteFolderPath: string
  cleanup: () => void
  /** Docker only: makes sshd refuse TCP forwarding for connections opened after it. */
  blockTcpForwarding?: () => void
  /** Docker only: runs a shell command on the host as the SSH user and returns its stdout. */
  exec?: (command: string) => string
}

/** `docker`, or the path of a Windows host-cell descriptor. */
export function startOrcadConvertHost(source: string, testInfo: TestInfo): OrcadConvertHost {
  const label = `orcad convert E2E ${Date.now()}`
  if (source === 'docker') {
    const target = startDockerSshRelayTarget(testInfo)
    return {
      input: {
        label,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      },
      remoteRepoPath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
      remoteFolderPath: '/tmp',
      cleanup: () => cleanupDockerSshRelayTarget(target),
      blockTcpForwarding: () => blockDockerSshRelayTargetTcpForwarding(target),
      exec: (command) => execDockerSshRelayTargetCommand(target, command)
    }
  }
  const descriptor = parseWindowsHostCellDescriptor(readFileSync(source, 'utf8'))
  return {
    input: {
      label,
      host: descriptor.host,
      port: descriptor.port,
      username: descriptor.username,
      identityFile: descriptor.identityFile,
      identitiesOnly: true,
      relayGracePeriodSeconds: 1
    },
    // The lane creates this repository as the account before it runs the cell.
    remoteRepoPath: `${descriptor.home}/orca-convert-repo`,
    remoteFolderPath: descriptor.home,
    cleanup: () => {}
  }
}
