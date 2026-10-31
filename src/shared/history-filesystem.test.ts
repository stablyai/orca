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
import type { ChildProcess } from 'node:child_process'
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
function attempt(run: () => string): string {
  try {
    return run()
  } catch (error) {
    return `throws:${(error as { code?: string }).code ?? String(error)}`
  }
}
// R3-4: the same-file postcondition is recorded before any expectation can stop the test.
function observeAlias(
  label: string,
  root: string,
  target: string,
  result: string,
  barrier?: string
): void {
  const entry = (path: string) => {
    if (!existsSync(path)) {
      return { exists: false }
    }
    const stats = statSync(path, { bigint: true })
    return {
      exists: true,
      id: `${stats.dev}:${stats.ino}`,
      links: Number(stats.nlink),
      content: readFileSync(path, 'utf8')
    }
  }
  const names = {
    source: entry(join(root, 'source', 'entry')),
    target: entry(join(root, 'destination', target))
  }
  const platform = `${process.platform}-${process.arch}`
  console.log(JSON.stringify({ tag: 'R3-4-OBSERVE', platform, label, result, barrier, ...names }))
}
// Test-only barrier: a read-handle oplock on the source makes the move's rename wait for this
// process, which creates the alias through its own handle and then acknowledges by closing.
const OPLOCK_HOLDER = String.raw`param([string]$Source, [string]$Alias, [int]$Timeout)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OrcaOplockHolder {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, IntPtr returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateEventW(IntPtr security, bool manual, bool initial, IntPtr name);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(IntPtr handle, IntPtr status, IntPtr information, uint length, int informationClass);
  static IntPtr Zeroed(int size) {
    IntPtr memory = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i++) Marshal.WriteByte(memory, i, 0);
    return memory;
  }
  public static string Run(string source, string alias, int timeout) {
    IntPtr file = CreateFileW(source, 0x80000000, 7, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
    if (file == new IntPtr(-1)) return "{\"error\":\"open " + Marshal.GetLastWin32Error() + "\"}";
    IntPtr overlapped = Zeroed(64);
    IntPtr signal = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
    Marshal.WriteIntPtr(overlapped, 2 * IntPtr.Size + 8, signal);
    IntPtr input = Zeroed(12);
    Marshal.WriteInt16(input, 0, 1); Marshal.WriteInt16(input, 2, 12);
    Marshal.WriteInt32(input, 4, 3); Marshal.WriteInt32(input, 8, 1);
    IntPtr output = Zeroed(24);
    Marshal.WriteInt16(output, 0, 1); Marshal.WriteInt16(output, 2, 24);
    bool done = DeviceIoControl(file, 0x00090240, input, 12, output, 24, IntPtr.Zero, overlapped);
    int requested = Marshal.GetLastWin32Error();
    if (done || requested != 997) { CloseHandle(file); return "{\"error\":\"oplock " + requested + "\"}"; }
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    if (WaitForSingleObject(signal, (uint)timeout) != 0) { CloseHandle(file); return "{\"broken\":false}"; }
    byte[] name = Encoding.Unicode.GetBytes("\\??\\" + alias);
    int size = Math.Max(24, 20 + name.Length);
    IntPtr link = Zeroed(size);
    Marshal.WriteInt32(link, 16, name.Length);
    Marshal.Copy(name, 0, new IntPtr(link.ToInt64() + 20), name.Length);
    int linked = NtSetInformationFile(file, Zeroed(16), link, (uint)size, 11);
    CloseHandle(file);
    return "{\"broken\":true,\"level\":" + Marshal.ReadInt32(output, 8) + ",\"link\":" + linked + "}";
  }
}
'@
[Console]::Out.WriteLine([OrcaOplockHolder]::Run($Source, $Alias, $Timeout))
`
async function holdOplock(
  root: string,
  source: string,
  alias: string,
  timeout: number
): Promise<{ child: ChildProcess; result: Promise<string> }> {
  const script = join(root, 'oplock-holder.ps1')
  writeFileSync(script, OPLOCK_HOLDER)
  const child = spawnProcess({
    program: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      source,
      alias,
      String(timeout)
    ],
    stdio: 'pipe'
  })
  let text = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    text += chunk
  })
  const closed = once(child, 'close', { signal: AbortSignal.timeout(45_000) })
  await new Promise<void>((resolveReady, reject) => {
    child.stdout.on('data', (chunk: string) => {
      text += chunk
      if (text.includes('ready')) {
        resolveReady()
      }
    })
    child.once('close', () => reject(new Error(`oplock holder exited before ready: ${text}`)))
  })
  return { child, result: closed.then(() => text.trim().split('\n').at(-1)!.trim()) }
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
      const aliased = attempt(() => f.from.move('entry', f.to, 'alias'))
      observeAlias('pre-existing-alias', f.root, 'alias', aliased)
      expect(aliased).toBe('collision')
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

  it('reads, writes and removes files only through the opened directory', () => {
    const f = fixture()
    try {
      const source = join(f.root, 'source')
      f.from.write('cursor', '00000000000000000012\n', true)
      expect(() => f.from.write('cursor', 'again', true)).toThrow(/EEXIST/)
      f.from.write('cursor', '00000000000000000034\n', false)
      expect(f.from.read('cursor').toString('utf8')).toBe('00000000000000000034\n')
      expect(() => f.from.write('absent', '1', false)).toThrow(/ENOENT/)
      linkSync(join(source, 'cursor'), join(source, 'alias'))
      expect(f.from.identity('alias')).toBe(f.from.identity('cursor'))
      f.from.unlink('alias')
      expect(f.from.read('cursor').toString('utf8')).toBe('00000000000000000034\n')
      symlinkSync(
        join(f.root, 'destination'),
        join(source, 'view'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      expect(() => f.from.read('view')).toThrow()
      expect(() => f.from.write('view', '1', false)).toThrow()
      f.from.unlink('cursor')
      expect(f.from.kind('cursor')).toBeNull()
      expect(() => f.from.read('cursor')).toThrow(/ENOENT/)
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
  it.runIf(process.platform === 'win32')(
    'retains an alias created while the move holds its source',
    async () => {
      const f = fixture()
      const holders: ChildProcess[] = []
      try {
        const source = join(f.root, 'source', 'entry')
        writeFileSync(source, 'A')
        // Control: opening the source alone must not reach the barrier.
        const control = await holdOplock(
          f.root,
          source,
          join(f.root, 'destination', 'early'),
          3_000
        )
        holders.push(control.child)
        const refused = attempt(() => f.from.move('entry', f.to, 'early', true))
        observeAlias('open-only-control', f.root, 'early', refused, await control.result)
        const held = await holdOplock(f.root, source, join(f.root, 'destination', 'late'), 10_000)
        holders.push(held.child)
        const raced = attempt(() => f.from.move('entry', f.to, 'late'))
        const barrier = await held.result
        observeAlias('alias-during-held-move', f.root, 'late', raced, barrier)
        expect(JSON.parse(barrier)).toMatchObject({ broken: true, link: 0 })
        expect(raced).toBe('collision')
        expect(statSync(source).ino).toBe(statSync(join(f.root, 'destination', 'late')).ino)
      } finally {
        for (const child of holders) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill()
          }
        }
        f.from.close()
        f.to.close()
        f.parent.close()
      }
    },
    60_000
  )
})
