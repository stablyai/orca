import { describe, expect, it } from 'vitest'
import { createGitBashConsoleCapacityDetector } from './git-bash-console-capacity'

describe('Git Bash console capacity detection', () => {
  it('recognizes the MSYS fatal message across PTY chunks', () => {
    const detector = createGitBashConsoleCapacityDetector()

    detector.observe('console device allocation failure - too many consoles ')
    detector.observe('in use, max consoles is 128')

    expect(detector.detected()).toBe(true)
  })

  it('ignores unrelated shell failures', () => {
    const detector = createGitBashConsoleCapacityDetector()
    detector.observe('bash: command not found')

    expect(detector.detected()).toBe(false)
  })
})
