import { describe, expect, it } from 'vitest'
import {
  CODEX_MINIMUM_SUPPORTED_VERSION,
  codexCliInstallation,
  readCodexInstallationProblem
} from './codex-cli-installation'

describe('Codex structured chat version floor', () => {
  it.each([
    ['codex-cli 0.135.0', 'unsupported'],
    ['codex-cli 0.136.0', 'ready'],
    ['codex-cli v0.136.0', 'ready'],
    ['0.136.0-alpha.2', 'unsupported'],
    ['0.136.0+build.2', 'ready'],
    ['0.137.0-alpha.2', 'ready'],
    ['codex-cli 0.153.4\n', 'ready'],
    ['codex-cli 1.0.0', 'ready'],
    ['codex-cli unknown', 'unknown'],
    ['company-wrapper 0.1.0\ncodex-cli 0.136.0', 'ready'],
    ['company-wrapper 9.0.0\ncodex-cli 0.135.0', 'unsupported'],
    ['codex-cli 0.135.0\ncodex-cli 0.136.0', 'unknown'],
    ['wrapper 0.135.0', 'unknown'],
    ['0.135.0\n0.136.0', 'unknown'],
    ['', 'unknown']
  ])('%s is %s', (output, status) => {
    expect(codexCliInstallation(true, output)).toMatchObject({
      status,
      minimumVersion: CODEX_MINIMUM_SUPPORTED_VERSION
    })
  })

  it('distinguishes an absent binary from an unverifiable version', () => {
    expect(codexCliInstallation(false, null)).toMatchObject({ status: 'missing', version: null })
    expect(codexCliInstallation(true, null)).toMatchObject({ status: 'unknown', version: null })
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
