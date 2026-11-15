// @orca-isolated-worker: this executable owner closes permanently at the end of its contract.
import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePairingOffer } from '../pairing/pairing'
import {
  closeEnvironmentStore,
  useInlineEnvironmentStoreForCli
} from './runtime-environment-store-worker-client'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed,
  resolveEnvironment
} from './runtime-environment-store'
import {
  getEnvironmentStorePath,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-records'

it('keeps the disposable CLI owner fresh, isolated, ordered and durable through close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-environment-cli-'))
  try {
    useInlineEnvironmentStoreForCli()
    const args = {
      name: 'Before',
      now: 100,
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'wss://synthetic.invalid/runtime',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
        deviceToken: 'synthetic'
      })
    }
    const added = addEnvironmentFromPairingCode(root, args)
    args.name = 'Changed after admission'
    const listing = listEnvironments(root)
    expect(() => useInlineEnvironmentStoreForCli()).toThrow('placement is already sealed')
    const saved = await added
    expect((await listing).map((environment) => environment.id)).toEqual([saved.id])
    saved.name = 'Caller mutation'
    expect((await resolveEnvironment(root, saved.id)).name).toBe('Before')
    const path = getEnvironmentStorePath(root)
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    disk.environments[0].name = 'External'
    disk.environments.push({ id: 'future', kind: 'future' })
    writeFileSync(path, JSON.stringify(disk), { mode: 0o600 })
    expect((await resolveEnvironment(root, saved.id)).name).toBe('External')
    await expect(resolveEnvironment(root, 'missing')).rejects.toBeInstanceOf(
      RuntimeEnvironmentStoreError
    )
    const update = markEnvironmentUsed(root, saved.id, { runtimeId: 'final', now: 100_000 })
    const close = closeEnvironmentStore()
    await expect(listEnvironments(root)).rejects.toThrow('Environment store is closing')
    await update
    await close
    expect(JSON.parse(readFileSync(path, 'utf8')).environments).toEqual([
      expect.objectContaining({ name: 'External', runtimeId: 'final' }),
      { id: 'future', kind: 'future' }
    ])
  } finally {
    await closeEnvironmentStore()
    rmSync(root, { recursive: true, force: true })
  }
})
