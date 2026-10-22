import { describe, expect, it } from 'vitest'
import { parseCodexCliVersion, readCodexInstallationProblem } from './codex-cli-installation'

describe('Codex CLI version', () => {
  it.each([
    ['codex-cli 0.135.0', '0.135.0'],
    ['codex-cli v0.136.0', '0.136.0'],
    ['0.136.0-alpha.2', '0.136.0-alpha.2'],
    ['0.136.0+build.2', '0.136.0+build.2'],
    ['codex-cli 0.153.4\n', '0.153.4'],
    ['codex-cli unknown', null],
    ['company-wrapper 0.1.0\ncodex-cli 0.136.0', '0.136.0'],
    ['company-wrapper 9.0.0\ncodex-cli 0.135.0', '0.135.0'],
    ['codex-cli 0.135.0\ncodex-cli 0.136.0', null],
    ['wrapper 0.135.0', null],
    ['0.135.0\n0.136.0', null],
    ['', null]
  ])('%j reads as %s', (output, version) => {
    expect(parseCodexCliVersion(output)).toBe(version)
  })

  it('admits only version facts that can safely be put in the refusal sentence', () => {
    const problem = { installedVersion: '0.135.0', minimumVersion: '0.136.0' }
    expect(readCodexInstallationProblem(problem)).toEqual(problem)
    expect(readCodexInstallationProblem({ ...problem, installedVersion: null })).toEqual({
      ...problem,
      installedVersion: null
    })
    expect(
      readCodexInstallationProblem({ ...problem, installedVersion: '<script>' })
    ).toBeUndefined()
    expect(readCodexInstallationProblem({ ...problem, minimumVersion: '' })).toBeUndefined()
  })
})
