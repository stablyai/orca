import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import './release-checkout-publication'
import { withReleaseSourceLease } from './release-source-retention'
import './release-source-cache'

const roots: string[] = []
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'orca-release-source-retention-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('releases the copy lease after an operation fails', async () => {
  const root = await scratch()
  await expect(
    withReleaseSourceLease(root, async () => {
      throw new Error('copy failed')
    })
  ).rejects.toThrow('copy failed')
  await expect(withReleaseSourceLease(root, async () => 'recovered')).resolves.toBe('recovered')
})
