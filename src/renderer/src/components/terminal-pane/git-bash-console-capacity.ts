const GIT_BASH_CONSOLE_CAPACITY_MARKER = 'too many consoles in use, max consoles is 128'

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
      const candidate = (tail + data).toLowerCase()
      matched = candidate.includes(GIT_BASH_CONSOLE_CAPACITY_MARKER)
      tail = candidate.slice(-(GIT_BASH_CONSOLE_CAPACITY_MARKER.length - 1))
    },
    detected: () => matched
  }
}
