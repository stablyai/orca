import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { loadHistoryFilesystem } from './history-filesystem'

const THIRD_PARTY_TAG = String.raw`param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrcaReparseTag {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr handle, uint code, byte[] input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static string Run(string path) {
    IntPtr file = CreateFileW(path, 0x40000000, 0, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);
    if (file == new IntPtr(-1)) return "open " + Marshal.GetLastWin32Error();
    // REPARSE_GUID_DATA_BUFFER: tag, data length, reserved, GUID, then 4 data bytes.
    byte[] buffer = new byte[28];
    BitConverter.GetBytes(0x0000ABCDu).CopyTo(buffer, 0);
    BitConverter.GetBytes((ushort)4).CopyTo(buffer, 4);
    Guid.NewGuid().ToByteArray().CopyTo(buffer, 8);
    uint returned;
    bool tagged = DeviceIoControl(file, 0x000900A4, buffer, 28, IntPtr.Zero, 0, out returned, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    CloseHandle(file);
    return tagged ? "tagged" : "tag " + error;
  }
}
'@
[Console]::Out.WriteLine([OrcaReparseTag]::Run($Path))
`

describe.skipIf(process.platform !== 'win32')('actual Windows directory capabilities', () => {
  it('creates junctions without symlink privilege and consumes opaque entries without their referents', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-history-junction-'))
    const binding = loadHistoryFilesystem()
    let root
    try {
      root = binding.openDirectory(path, false)
      mkdirSync(join(path, 'store'))
      writeFileSync(join(path, 'store', 'keep'), 'untouched')
      // Setup passes the namespaced form; the junction still reads back as the plain path.
      root.link('view', toNamespacedPath(join(path, 'store')))
      expect(root.readLink('view')).toBe(join(path, 'store'))
      expect(lstatSync(join(path, 'view')).isSymbolicLink()).toBe(true)
      expect(root.kind('view')).toBe('link')
      expect(() => root.open('view')).toThrow()
      expect(() => root.move('view', root!, 'not-a-directory', true)).toThrow()
      expect(root.move('view', root, 'pending')).toBe('moved')
      expect(root.move('pending', root, 'view')).toBe('moved')
      expect(readFileSync(join(path, 'store', 'keep'), 'utf8')).toBe('untouched')
      expect(() => root.link('view', join(path, 'store'))).toThrow()
    } finally {
      root?.close()
      rmSync(path, { recursive: true, force: true })
    }
  })
  it('treats a non-link reparse file as a file, like the runtime does', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-history-reparse-'))
    const file = join(path, 'history.jsonl')
    writeFileSync(file, 'prompt\n')
    // A third-party tag stands in for dedup, cloud and compression tags: none of them is a link.
    const script = join(path, 'tag.ps1')
    writeFileSync(script, THIRD_PARTY_TAG)
    const shell = spawnProcess({
      program: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        file
      ],
      stdio: 'pipe'
    })
    let output = ''
    shell.stdout.setEncoding('utf8')
    shell.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    shell.stderr.setEncoding('utf8')
    shell.stderr.on('data', (chunk: string) => {
      output += chunk
    })
    await once(shell, 'close')
    let root
    try {
      expect(output.trim()).toBe('tagged')
      expect(lstatSync(file).isSymbolicLink()).toBe(false)
      root = loadHistoryFilesystem().openDirectory(path, false)
      expect(root.kind('history.jsonl')).toBe('file')
    } finally {
      root?.close()
      rmSync(path, { recursive: true, force: true })
    }
  }, 60_000)
})
