const GIT_BASH_CONSOLE_CAPACITY_MARKER = 'too many consoles in use, max consoles is 128'
const CARRY_LENGTH = GIT_BASH_CONSOLE_CAPACITY_MARKER.length - 1
// Why this char: a match that was not already found must end inside the new chunk, so the chunk has
// to contain the marker's final character. It is a digit, so the test needs no case folding.
const MARKER_FINAL_CHAR = GIT_BASH_CONSOLE_CAPACITY_MARKER.slice(-1)

export type GitBashConsoleCapacityDetector = {
  observe: (data: string) => void
  detected: () => boolean
}

// A finite limit bounds decoded output in UTF-16 code units, before case folding.
export function createGitBashConsoleCapacityDetector(
  outputLimit = Number.POSITIVE_INFINITY
): GitBashConsoleCapacityDetector {
  let tail = ''
  let matched = false
  let remaining = outputLimit

  return {
    observe(data) {
      if (matched || remaining === 0 || data.length === 0) {
        return
      }
      data = data.slice(0, remaining)
      remaining -= data.length
      if (!data.includes(MARKER_FINAL_CHAR)) {
        // Fold only the carry instead of copying the whole chunk: this runs per PTY chunk per pane.
        tail =
          data.length >= CARRY_LENGTH
            ? data.slice(-CARRY_LENGTH).toLowerCase()
            : (tail + data).slice(-CARRY_LENGTH).toLowerCase()
        return
      }
      const candidate = (tail + data).toLowerCase()
      matched = candidate.includes(GIT_BASH_CONSOLE_CAPACITY_MARKER)
      tail = candidate.slice(-CARRY_LENGTH)
    },
    detected: () => matched
  }
}
