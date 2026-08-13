/**
 * Freezes the detached relay without killing it.
 *
 * Why this fault and not a transport sever: a sever reconnects through the
 * checkpoint path and never classifies a reattach failure at all (see the header
 * of ssh-maxsessions-remote-pid-binding-identity.spec.ts). A stopped relay still
 * holds every shell it hosts — SIGSTOP suspends one process, not its children —
 * so a `pty.attach` aimed at it runs out its request timeout while the shell the
 * pane owns keeps running. That is the shape STA-3077 is about: a reattach that
 * failed, over a session that is provably still alive.
 *
 * SIGCONT puts it back, so the same shell can be reattached afterwards.
 */
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

/** Guards every signal: only a detached relay may be stopped or resumed. */
function signalDetachedRelay(
  target: DockerSshRelayTarget,
  relayPid: number,
  signal: 'STOP' | 'CONT'
): void {
  if (!Number.isInteger(relayPid) || relayPid <= 0) {
    throw new Error(`Docker SSH relay process ID must be a positive integer: ${relayPid}`)
  }
  execDockerSshRelayTargetCommand(
    target,
    [
      `proc=/proc/${relayPid}`,
      '[ -r "$proc/cmdline" ]',
      'argv=()',
      'mapfile -d \'\' -t argv < "$proc/cmdline"',
      '[ "${argv[1]##*/}" = relay.js ]',
      '[[ " ${argv[*]:2} " = *" --detached "* ]]',
      `kill -${signal} ${relayPid}`
    ].join(' && ')
  )
}

export function stallDockerSshRelay(target: DockerSshRelayTarget, relayPid: number): void {
  signalDetachedRelay(target, relayPid, 'STOP')
  // Read the stop back off /proc rather than trusting the signal: an attach that
  // is answered anyway would make every oracle downstream vacuous.
  const state = execDockerSshRelayTargetCommand(
    target,
    `awk '/^State:/{print $2}' /proc/${relayPid}/status`
  )
  if (state !== 'T') {
    throw new Error(`The detached relay did not stop; /proc reports state ${state || '<gone>'}`)
  }
}

export function resumeDockerSshRelay(target: DockerSshRelayTarget, relayPid: number): void {
  signalDetachedRelay(target, relayPid, 'CONT')
}

/** True while the relay process still exists, whatever state it is in. */
export function isDockerSshRelayProcessPresent(
  target: DockerSshRelayTarget,
  relayPid: number
): boolean {
  return (
    execDockerSshRelayTargetCommand(
      target,
      `test -r /proc/${relayPid}/status && echo PRESENT || echo GONE`
    ) === 'PRESENT'
  )
}
