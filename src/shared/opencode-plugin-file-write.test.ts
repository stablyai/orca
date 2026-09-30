import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeFs from 'node:fs'

const faults = vi.hoisted(() => ({ failStaging: false, failRename: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.failStaging && String(args[0]).endsWith('.tmp')) {
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      }
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.failRename) {
        throw Object.assign(new Error('file is in use'), { code: 'EPERM' })
      }
      return actual.renameSync(...args)
    }
  }
})

import { writeOpenCodePluginFile } from './opencode-plugin-file-write'

describe('writeOpenCodePluginFile', () => {
  const realPlatform = process.platform
  let dir: string
  let pluginPath: string

  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: platform })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opencode-plugin-write-'))
    pluginPath = join(dir, 'orca-status.js')
    faults.failStaging = false
    faults.failRename = false
  })

  afterEach(() => {
    setPlatform(realPlatform)
    rmSync(dir, { recursive: true, force: true })
  })

  describe.skipIf(process.platform === 'win32')('links and modes', () => {
    it('writes through a dangling absolute symlink instead of replacing it', () => {
      const targetPath = join(dir, 'dotfiles-status.js')
      symlinkSync(targetPath, pluginPath)

      writeOpenCodePluginFile(pluginPath, 'plugin', 'write-through-link')

      expect(lstatSync(pluginPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf8')).toBe('plugin')
    })

    it('writes through a dangling relative symlink instead of replacing it', () => {
      symlinkSync('dotfiles-status.js', pluginPath)

      writeOpenCodePluginFile(pluginPath, 'plugin', 'write-through-link')

      expect(lstatSync(pluginPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(dir, 'dotfiles-status.js'), 'utf8')).toBe('plugin')
    })

    it('keeps the mode of the file it replaces', () => {
      writeFileSync(pluginPath, 'stale')
      chmodSync(pluginPath, 0o640)

      writeOpenCodePluginFile(pluginPath, 'plugin', 'write-through-link')

      expect(statSync(pluginPath).mode & 0o777).toBe(0o640)
      expect(readFileSync(pluginPath, 'utf8')).toBe('plugin')
    })
  })

  describe('Windows fallback', () => {
    it('leaves the installed plugin alone when staging the new copy fails', () => {
      writeFileSync(pluginPath, 'stale')
      setPlatform('win32')
      faults.failStaging = true

      expect(() => writeOpenCodePluginFile(pluginPath, 'plugin', 'replace-link')).toThrow(
        'no space left'
      )

      expect(readFileSync(pluginPath, 'utf8')).toBe('stale')
      expect(readdirSync(dir)).toEqual(['orca-status.js'])
    })

    it('writes directly over a regular file that cannot be renamed over', () => {
      writeFileSync(pluginPath, 'stale')
      setPlatform('win32')
      faults.failRename = true

      writeOpenCodePluginFile(pluginPath, 'plugin', 'replace-link')

      expect(readFileSync(pluginPath, 'utf8')).toBe('plugin')
      expect(readdirSync(dir)).toEqual(['orca-status.js'])
    })

    it.skipIf(process.platform === 'win32')(
      'does not write through a link it was asked to replace',
      () => {
        const userFile = join(dir, 'user-plugin.js')
        writeFileSync(userFile, 'user plugin')
        symlinkSync(userFile, pluginPath)
        setPlatform('win32')
        faults.failRename = true

        expect(() => writeOpenCodePluginFile(pluginPath, 'plugin', 'replace-link')).toThrow(
          'file is in use'
        )

        expect(readFileSync(userFile, 'utf8')).toBe('user plugin')
      }
    )
  })
})
