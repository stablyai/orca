export type PosixStdoutFence = {
  /** POSIX script that prints the begin marker, runs the payload, then prints the end marker. */
  command: string
  /** Payload the command wrote, or null when the fence never appeared. */
  readStdout: (stdout: string) => string | null
  // Expose raw markers for binary git-show slicing; renderer bundles cannot import Buffer.
  beginMarker: string
  endMarker: string
}

// Nonce markers avoid collisions in rc output and payloads (e.g. files quoting a fixed marker). Not security-sensitive; Math.random suffices.
function nextPosixStdoutFenceNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Fence captured stdout against login rc banners, echoes and title escapes from WSL/SSH shells; label distinguishes transports. */
export function buildPosixStdoutFence(
  command: string,
  label: string,
  nonce: string = nextPosixStdoutFenceNonce()
): PosixStdoutFence {
  const { printBegin, printEnd, ...markers } = fenceMarkers(label, nonce)
  return {
    ...markers,
    command: [
      // Markers are [A-Za-z0-9_] only, so they need no quoting.
      `printf %s ${printBegin.join(' ')}`,
      command,
      '_orca_capture_status=$?',
      `printf %s ${printEnd.join(' ')}`,
      'exit $_orca_capture_status'
    ].join('\n')
  }
}

/** One-line fence parsed by sh/bash/zsh/fish/csh. Fish/csh lack $? so the closing printf, not the payload, determines exit status. */
export function buildAnyShellStdoutFence(
  command: string,
  label: string,
  nonce: string = nextPosixStdoutFenceNonce()
): PosixStdoutFence {
  const { printBegin, printEnd, ...markers } = fenceMarkers(label, nonce)
  return {
    ...markers,
    // Unquoted: nested quoting differs between these shells, and the markers need none.
    command: `printf %s ${printBegin.join(' ')}; ${command}; printf %s ${printEnd.join(' ')}`
  }
}

type FenceMarkers = Omit<PosixStdoutFence, 'command'> & {
  /** `printf %s` arguments that join into each marker. */
  printBegin: [string, string]
  printEnd: [string, string]
}

function fenceMarkers(label: string, nonce: string): FenceMarkers {
  const beginPrefix = `__ORCA_${label}_CAPTURE_BEGIN_`
  const endPrefix = `__ORCA_${label}_CAPTURE_END_`
  const begin = `${beginPrefix}${nonce}__`
  const end = `${endPrefix}${nonce}__`
  return {
    beginMarker: begin,
    endMarker: end,
    // Split markers so command echoes from ps/set -v cannot be mistaken for emitted fences.
    printBegin: [beginPrefix, `${nonce}__`],
    printEnd: [endPrefix, `${nonce}__`],
    readStdout: (stdout) => {
      // A nonce excludes payload/rc collisions; lastIndexOf handles repeated shell markers.
      const beginIndex = stdout.lastIndexOf(begin)
      if (beginIndex === -1) {
        return null
      }
      const payloadStart = beginIndex + begin.length
      const endIndex = stdout.indexOf(end, payloadStart)
      // Early exit skips the closing fence; retain remaining output, including login-shell exit hooks.
      return endIndex === -1 ? stdout.slice(payloadStart) : stdout.slice(payloadStart, endIndex)
    }
  }
}
