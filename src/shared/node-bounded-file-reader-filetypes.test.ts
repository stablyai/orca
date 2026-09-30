import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'

it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-bounded-fifo-'))
  try {
    const fifo = join(root, 'fifo')
    const reader = join(root, 'reader.cjs')
    const create = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 2000 })
    expect(create.code).toBe(0)
    await build({
      entryPoints: [resolve('src/shared/node-bounded-file-reader.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: reader
    })
    const result = await runProcess({
      program: process.execPath,
      args: [
        '-e',
        `try { require(process.argv[1]).readNodeFileSyncWithinLimit(process.argv[2], 1024, { requireRegularFile: true }); process.exit(1) } catch (error) { process.exit(error.message === 'Expected a regular file' ? 0 : 2) }`,
        reader,
        fifo
      ],
      timeoutMs: 2000
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
