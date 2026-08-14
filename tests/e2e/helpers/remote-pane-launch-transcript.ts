/**
 * A stand-in for an agent's transcript, recorded by the host rather than by the app.
 *
 * The STA-3077 report's second failure is "a coding agent was resumed twice into
 * one transcript". Driving a real coding agent inside the Docker OpenSSH fixture
 * is not possible — no agent binary ships in the image and no provider session
 * exists to resume — so the observable is moved to the thing that actually goes
 * wrong: a second shell launching for a pane that already has one. Every shell
 * the relay starts for a pane appends one line here, keyed by pane, so "resumed
 * twice" reads as two lines for one pane key and needs no app-side reporting to
 * be believed.
 *
 * The hook is installed before the first pane exists, and each test asserts the
 * first launch was recorded before asserting no second one was — a hook that
 * silently failed to fire would otherwise make every clause pass vacuously.
 */
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

const TRANSCRIPT_PATH = '/tmp/orca-pane-launch-transcript.log'

// Prepended, not appended: Debian's stock /root/.bashrc returns early for a
// non-interactive shell, and a hook placed after that guard would only fire
// sometimes. `ORCA_PANE_KEY` is injected by the pane launch path alone, so a
// `docker exec` probe shell adds nothing.
const INSTALL_TRANSCRIPT_HOOK_COMMAND = `
set -e
hook=/root/.orca-pane-launch-transcript.sh
cat > "$hook" <<'HOOK'
if [ -n "$ORCA_PANE_KEY" ]; then
  printf '%s\\t%s\\n' "$ORCA_PANE_KEY" "$$" >> ${TRANSCRIPT_PATH}
fi
HOOK
touch /root/.bashrc ${TRANSCRIPT_PATH}
if ! grep -q orca-pane-launch-transcript /root/.bashrc; then
  printf '. %s\\n' "$hook" | cat - /root/.bashrc > /root/.bashrc.next
  mv /root/.bashrc.next /root/.bashrc
fi
grep -c orca-pane-launch-transcript /root/.bashrc
`

export function installRemotePaneLaunchTranscript(target: DockerSshRelayTarget): void {
  const installed = Number(
    execDockerSshRelayTargetCommand(target, INSTALL_TRANSCRIPT_HOOK_COMMAND).split('\n').pop()
  )
  if (installed !== 1) {
    throw new Error(`The pane launch transcript hook was not installed exactly once: ${installed}`)
  }
}

/** Every shell launch the host recorded, oldest first, as `paneKey\tpid`. */
export function readRemotePaneLaunchTranscript(target: DockerSshRelayTarget): string[] {
  return execDockerSshRelayTargetCommand(target, `cat ${TRANSCRIPT_PATH} 2>/dev/null || true`)
    .split('\n')
    .filter((line) => line.includes('\t'))
}

/** The pids the host launched a shell for under one pane key. */
export function readRemotePaneLaunchPids(target: DockerSshRelayTarget, paneKey: string): number[] {
  return readRemotePaneLaunchTranscript(target)
    .filter((line) => line.split('\t')[0] === paneKey)
    .map((line) => Number(line.split('\t')[1]))
}
