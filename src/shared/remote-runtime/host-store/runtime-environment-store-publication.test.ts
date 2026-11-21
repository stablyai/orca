import { afterEach, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEnvironmentStoreBatch } from './runtime-environment-store-batch'
import { environmentStoreWriteCount } from './runtime-environment-store-write-generation'
import { writeRuntimeEnvironmentSidecarEntry } from './runtime-environment-sidecar'
import { writeWslHostDeployment } from './wsl-host-deployment-store'
import { encodePairingOffer } from '../pairing/pairing'

const fault = vi.hoisted((): { at: 'file' | 'directory' | undefined } => ({ at: undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      const directory = fs.fstatSync(fd).isDirectory()
      if ((directory && fault.at === 'directory') || (!directory && fault.at === 'file')) {
        throw Object.assign(new Error('synthetic durability failure'), { code: 'EIO' })
      }
      return fs.fsyncSync(fd)
    }
  }
})
const posixIt = process.platform === 'win32' ? it.skip : it
const roots: string[] = []
afterEach(() => {
  fault.at = undefined
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

posixIt.each(['file', 'directory'] as const)(
  'counts a published registry write when %s fsync fails',
  (at) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-environment-publication-'))
    roots.push(root)
    const before = environmentStoreWriteCount()
    fault.at = at
    const result = runEnvironmentStoreBatch({
      id: 1,
      servingWsl: false,
      commands: [
        {
          operation: 'addEnvironmentFromPairingCode',
          args: [
            root,
            {
              name: 'Published',
              now: 100,
              pairingCode: encodePairingOffer({
                v: 2,
                endpoint: 'wss://synthetic.invalid/runtime',
                publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
                deviceToken: 'synthetic'
              })
            }
          ]
        }
      ]
    })
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: 'EIO' } })
    expect(result.writes - before).toBe(at === 'directory' ? 1 : 0)
    fault.at = undefined
    const read = runEnvironmentStoreBatch({
      id: 2,
      servingWsl: false,
      commands: [{ operation: 'listEnvironments', args: [root] }]
    })
    expect(read.results[0]).toMatchObject({
      ok: true,
      result: { value: at === 'directory' ? [expect.objectContaining({ name: 'Published' })] : [] }
    })
  }
)

posixIt.each(['sidecar', 'wsl'] as const)(
  'counts published %s state despite a directory fsync error',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-environment-overlay-publication-'))
    roots.push(root)
    const before = environmentStoreWriteCount()
    fault.at = 'directory'
    const write = () =>
      kind === 'wsl'
        ? writeWslHostDeployment(root, 'env', null)
        : writeRuntimeEnvironmentSidecarEntry(
            root,
            [],
            {
              id: 'env',
              name: 'Synthetic',
              createdAt: 100,
              updatedAt: 100,
              pairingRevision: 100,
              runtimeId: null,
              lastUsedAt: null,
              preferredEndpointId: 'endpoint',
              endpoints: []
            },
            null
          )
    expect(write).toThrow('synthetic durability failure')
    expect(environmentStoreWriteCount() - before).toBe(1)
    const name = kind === 'wsl' ? 'orca-wsl-host-deployments.json' : 'orca-environment-sidecar.json'
    expect(JSON.parse(readFileSync(join(root, name), 'utf8')).version).toBe(1)
  }
)
