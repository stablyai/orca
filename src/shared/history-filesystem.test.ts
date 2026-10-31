import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { loadHistoryFilesystem } from './history-filesystem'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-history-capability-'))
  roots.push(root)
  const binding = loadHistoryFilesystem()
  const parent = binding.openDirectory(root, false)
  parent.mkdir('source')
  parent.mkdir('destination')
  return { root, parent, from: parent.open('source'), to: parent.open('destination') }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('actual history filesystem addon', () => {
  it('consumes once, retains collisions including hardlink aliases, and restores roots exclusively', () => {
    const f = fixture()
    try {
      const source = join(f.root, 'source'),
        target = join(f.root, 'destination')
      writeFileSync(join(source, 'entry'), 'A')
      writeFileSync(join(target, 'entry'), 'B')
      expect(f.from.move('entry', f.to, 'entry')).toBe('collision')
      expect(readFileSync(join(source, 'entry'), 'utf8')).toBe('A')
      expect(readFileSync(join(target, 'entry'), 'utf8')).toBe('B')
      linkSync(join(source, 'entry'), join(target, 'alias'))
      expect(f.from.move('entry', f.to, 'alias')).toBe('collision')
      const identity = statSync(join(source, 'entry')).ino
      expect(f.from.move('entry', f.to, 'moved')).toBe('moved')
      expect(statSync(join(target, 'moved')).ino).toBe(identity)
      expect(f.from.move('entry', f.to, 'other')).toBe('missing')
      if (process.platform !== 'win32') {
        chmodSync(source, 0o700)
        f.parent.mkdir('recreated', f.from)
        expect(statSync(join(f.root, 'recreated')).mode & 0o777).toBe(0o700)
      }
      f.parent.mkdir('occupied')
      expect(f.parent.move('source', f.parent, 'occupied', true)).toBe('collision')
      expect(f.parent.move('source', f.parent, 'pending', true)).toBe('moved')
      f.parent.mkdir('source')
      expect(f.parent.move('pending', f.parent, 'source')).toBe('collision')
      expect(f.parent.kind('pending')).toBe('directory')
    } finally {
      f.from.close()
      f.to.close()
      f.parent.close()
    }
  })

  it('keeps opened parent authority when its old pathname is reused as a link', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.root, 'source', 'entry'), 'original')
      writeFileSync(join(f.root, 'destination', 'entry'), 'unrelated-shared')
      renameSync(join(f.root, 'source'), join(f.root, 'old'))
      symlinkSync(
        join(f.root, 'destination'),
        join(f.root, 'source'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      expect(() => f.parent.open('source')).toThrow()
      expect(f.from.move('entry', f.to, 'saved')).toBe('moved')
      expect(readFileSync(join(f.root, 'destination', 'entry'), 'utf8')).toBe('unrelated-shared')
      expect(readFileSync(join(f.root, 'destination', 'saved'), 'utf8')).toBe('original')
      expect(() => f.parent.removeEmpty('source')).toThrow()
      expect(f.parent.kind('source')).toBe('link')
      expect(() => f.parent.open('../destination')).toThrow()
      f.from.close()
      expect(() => f.from.entries()).toThrow()
    } finally {
      f.from.close()
      f.to.close()
      f.parent.close()
    }
  })

  it('preserves both variants when independent processes publish the same leaf', async () => {
    const f = fixture()
    f.from.close()
    f.to.close()
    f.parent.close()
    const other = join(f.root, 'other')
    mkdirSync(other)
    writeFileSync(join(f.root, 'source', 'entry'), 'A')
    writeFileSync(join(other, 'entry'), 'B')
    const binary = createRequire(__filename).resolve(
      '../../native/history-filesystem/build/Release/history_filesystem.node'
    )
    const children = [join(f.root, 'source'), other].map((source) =>
      spawnProcess({
        program: process.execPath,
        args: [
          '--import',
          'tsx',
          resolve('src/shared/history-filesystem-process-fixture.ts'),
          binary,
          source,
          join(f.root, 'destination'),
          'entry'
        ],
        stdio: 'pipe'
      })
    )
    try {
      const outputs = children.map((child) => {
        let text = ''
        child.stdout.setEncoding('utf8')
        const ready = new Promise<void>((resolveReady, reject) => {
          child.stdout.on('data', (chunk: string) => {
            text += chunk
            if (text.includes('ready:')) {
              resolveReady()
            }
          })
          child.once('close', () => reject(new Error(`fixture exited before ready: ${text}`)))
        })
        return { ready, text: () => text }
      })
      const closed = children.map((child) =>
        once(child, 'close', { signal: AbortSignal.timeout(10_000) })
      )
      // Both processes hold their opened source and destination before either consumes.
      await Promise.all(outputs.map((output) => output.ready))
      for (const child of children) {
        child.stdin.write('move\n')
      }
      expect((await Promise.all(closed)).map(([code]) => code)).toEqual([0, 0])
      expect(outputs.map((output) => output.text().trim().split('\n').at(-1)).sort()).toEqual([
        'collision',
        'moved'
      ])
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
    }
    const variants = [
      join(f.root, 'source', 'entry'),
      join(other, 'entry'),
      join(f.root, 'destination', 'entry')
    ]
      .filter(existsSync)
      .map((path) => readFileSync(path, 'utf8'))
      .sort()
    expect(variants).toEqual(['A', 'B'])
  })
})
