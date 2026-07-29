import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from './cli-args.mjs'
import { proveDistinctInstallerPair } from './installer-pair-proof.mjs'

const scratchDirs = []

async function artifactPair(fromBody = 'artifact-a', toBody = 'artifact-b') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-installer-pair-proof-'))
  scratchDirs.push(directory)
  const fromPath = path.join(directory, 'orca-a.exe')
  const toPath = path.join(directory, 'orca-b.exe')
  await Promise.all([writeFile(fromPath, fromBody), writeFile(toPath, toBody)])
  return { fromPath, toPath }
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('packaged installer pair proof', () => {
  it('requires an explicit compatibility-gate flag', () => {
    const opts = parseArgs([
      '--from',
      'a.exe',
      '--to',
      'b.exe',
      '--expect',
      'cold-restore',
      '--require-distinct-artifacts'
    ])

    expect(opts.requireDistinctArtifacts).toBe(true)
  })

  it('records distinct paths, versions, and hashes', async () => {
    const pair = await artifactPair()

    const proof = await proveDistinctInstallerPair({
      ...pair,
      fromVersion: '1.4.130',
      toVersion: '1.4.131'
    })

    expect(proof.from.path).not.toBe(proof.to.path)
    expect(proof.from.version).not.toBe(proof.to.version)
    expect(proof.from.sha256).not.toBe(proof.to.sha256)
  })

  it('fails closed for byte-identical artifacts at different paths', async () => {
    const pair = await artifactPair('same-artifact', 'same-artifact')

    await expect(
      proveDistinctInstallerPair({
        ...pair,
        fromVersion: '1.4.130',
        toVersion: '1.4.131'
      })
    ).rejects.toThrow('SHA-256 hashes are identical')
  })

  it('fails closed for an identical path or version', async () => {
    const pair = await artifactPair()

    await expect(
      proveDistinctInstallerPair({
        fromPath: pair.fromPath,
        toPath: pair.fromPath,
        fromVersion: '1.4.130',
        toVersion: '1.4.130'
      })
    ).rejects.toThrow(/paths are identical.*hashes are identical.*versions are identical/)
  })

  it('fails closed when either package version is unavailable', async () => {
    const pair = await artifactPair()

    await expect(
      proveDistinctInstallerPair({
        ...pair,
        fromVersion: null,
        toVersion: '1.4.131'
      })
    ).rejects.toThrow('both installer versions must be readable')
  })
})
