const GIT_BASH_CONSOLE_CAPACITY_MARKER = 'too many consoles in use, max consoles is 128'
const CARRY_LENGTH = GIT_BASH_CONSOLE_CAPACITY_MARKER.length - 1
// Why this char: a match that was not already found must end inside the new chunk, so the chunk has
// to contain the marker's final character. It is a digit, so the test needs no case folding.
const MARKER_FINAL_CHAR = GIT_BASH_CONSOLE_CAPACITY_MARKER.at(-1) as string

export type GitBashConsoleCapacityDetector = {
  observe: (data: string) => void
  detected: () => boolean
}

export function createGitBashConsoleCapacityDetector(): GitBashConsoleCapacityDetector {
  let tail = ''
  let matched = false

  return {
    observe(data) {
      if (matched || data.length === 0) {
        return
      }
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
