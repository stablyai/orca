import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { withCliRuntimeOnPath } from './node-cli-command-resolution'

const realFs = vi.hoisted((): { closeSync: typeof fs.closeSync } => ({
  closeSync: () => {
    throw new Error('real closeSync was not captured by the node:fs mock')
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  realFs.closeSync = actual.closeSync
  return { ...actual, closeSync: vi.fn(actual.closeSync), readSync: vi.fn(actual.readSync) }
})

afterEach(() => vi.resetAllMocks())

describe('advisory executable inspection cleanup', () => {
  it.each([
    { kind: 'native', contents: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), readError: false },
    { kind: 'script', contents: Buffer.from('#!/usr/bin/env node\n'), readError: false },
    { kind: 'unreadable', contents: Buffer.from('#!/usr/bin/env node\n'), readError: true }
  ])(
    'preserves $kind runtime pairing when close reports EIO after releasing the handle',
    (input) => {
      const root = fs.mkdtempSync(join(tmpdir(), 'orca-cli-close-'))
      onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
      const command = join(root, 'codex')
      fs.writeFileSync(command, input.contents, { mode: 0o755 })
      fs.writeFileSync(join(root, process.platform === 'win32' ? 'node.exe' : 'node'), '', {
        mode: 0o755
      })
      if (input.readError) {
        vi.mocked(fs.readSync).mockImplementationOnce(() => {
          throw Object.assign(new Error('read failed'), { code: 'EIO' })
        })
      }
      let released = false
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
        realFs.closeSync(fd)
        released = true
        throw Object.assign(new Error('close failed'), { code: 'EIO' })
      })
      const env = { PATH: join(root, 'other-runtime'), ORCA_TEST_ENV: 'preserved' }
      const paired = withCliRuntimeOnPath(command, env)

      expect(paired).toEqual(
        input.kind === 'native' ? env : { ...env, PATH: [root, env.PATH].join(delimiter) }
      )
      if (input.kind === 'native') {
        expect(paired).toBe(env)
      }
      expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(expect.any(Number))
      expect(released).toBe(true)
    }
  )
})
