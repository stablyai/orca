import { describe, expect, it } from 'vitest'
import { classifyOpenCodeCliGeneration } from './opencode-cli-generation'

describe('classifyOpenCodeCliGeneration', () => {
  // Real outputs: v1 prints a bare semver, v2 prints `opencode v<semver>`
  // (issue #24987 verified both on the reported machine).
  it.each([
    ['1.18.34\n', 'v1'],
    ['1.18.30', 'v1'],
    ['opencode v2.0.22\n', 'v2'],
    ['2.0.22', 'v2'],
    ['opencode v2.0.16-beta.1', 'v2'],
    ['v2.0.0+build.7', 'v2']
  ])('classifies %j as %s', (output, generation) => {
    expect(classifyOpenCodeCliGeneration(output)).toBe(generation)
  })

  it.each(['3.0.0', 'wrapper 2.0.16', '', 'not a version', 'opencode v0.9.0'])(
    'returns null for unrecognised output %j',
    (output) => {
      expect(classifyOpenCodeCliGeneration(output)).toBeNull()
    }
  )

  it('reads the version line past a login-shell banner', () => {
    // Why: the WSL guest and the relay probe both concatenate streams a shell
    // may prepend to, so the version line is not necessarily the first line.
    expect(classifyOpenCodeCliGeneration('Welcome to Ubuntu!\nopencode v2.0.22\n')).toBe('v2')
  })
})
