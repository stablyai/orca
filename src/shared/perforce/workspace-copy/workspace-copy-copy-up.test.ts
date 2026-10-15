import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { P4CommandResult } from '../p4-command'
import { parseP4Spec } from './p4-spec'
import { copyUpWorkspaceCopy, previewWorkspaceCopyUp } from './workspace-copy-copy-up'
import type { WorkspaceCopyHost } from './workspace-copy-host'

const tag = (record: Record<string, string | number>): string =>
  `${Object.entries(record)
    .map(([key, value]) => `... ${key} ${value}`)
    .join('\n')}\n\n`
const ok = (stdout = ''): P4CommandResult => ({ code: 0, stdout, stderr: '' })

const STREAM = '//s/main_wt_one'

/** Just enough of a server for copy-up: one source client, the copy's client, its stream. */
class CopyUpServer {
  clients = new Map<string, { stream: string; root: string; opened: number }>()
  pending = new Map<number, string>()
  istat = { integToParent: 'true', integFromParent: 'false' }
  copyFiles = ['//s/main/a.txt', '//s/main/b.txt']
  unresolved = 0
  submitted: { change: number; description: string; client: string }[] = []
  calls: string[][] = []
  private next = 100

  constructor(ws: string) {
    this.clients.set('src', { stream: '//s/main', root: ws, opened: 0 })
    this.clients.set('src_wt_one', {
      stream: STREAM,
      root: join(ws, '..', 'ws.wt', 'one'),
      opened: 0
    })
  }

  run(raw: readonly string[], input?: string): P4CommandResult {
    this.calls.push([...raw])
    const args = [...raw]
    let client = 'src'
    for (;;) {
      if (args[0] === '-ztag') {
        args.shift()
      } else if (args[0] === '-c') {
        client = args[1]
        args.splice(0, 2)
      } else {
        break
      }
    }
    const [cmd, ...rest] = args
    const flag = (name: string): string | undefined => rest[rest.indexOf(name) + 1]
    switch (cmd) {
      case 'set':
        return ok(`P4CLIENT=src (config '${join(this.root('src'), 'p4config.txt')}')\n`)
      case 'info':
        return ok(
          tag({
            userName: 'me',
            clientName: client,
            clientRoot: this.root(client),
            clientStream: '//s/main'
          })
        )
      case 'clients': {
        const found = this.clients.get(rest[1])
        return ok(found ? tag({ client: rest[1], Root: found.root, Stream: found.stream }) : '')
      }
      case 'streams':
        return ok(rest[0] === STREAM ? tag({ Stream: STREAM, Parent: '//s/main' }) : '')
      case 'opened': {
        const count = this.clients.get(client)?.opened ?? 0
        return ok(
          Array.from({ length: count }, (_, i) => tag({ clientFile: `//${client}/f${i}` })).join('')
        )
      }
      case 'istat':
        return ok(tag({ stream: STREAM, parent: '//s/main', ...this.istat }))
      case 'client':
        return this.clientCommand(rest, input)
      case 'changes':
        if (flag('-s') === 'pending') {
          return ok(
            [...this.pending]
              .filter(([, owner]) => owner === flag('-c'))
              .map(([change]) => tag({ change, desc: 'x' }))
              .join('')
          )
        }
        return ok(
          tag({ change: 42, desc: 'fix the jump' }) + tag({ change: 41, desc: 'add a level' })
        )
      case 'change': {
        if (rest[0] === '-d') {
          this.pending.delete(Number(rest[1]))
          return ok()
        }
        const change = (this.next += 1)
        this.pending.set(change, client)
        return ok(`Change ${change} created.\n`)
      }
      case 'copy':
        return ok(
          this.copyFiles.map((depotFile) => tag({ depotFile, action: 'integrate' })).join('')
        )
      case 'resolve':
        return ok(
          Array.from({ length: this.unresolved }, (_, i) =>
            tag({ clientFile: `f${i}`, fromFile: `g${i}` })
          ).join('')
        )
      case 'submit': {
        const change = Number(flag('-c'))
        this.pending.delete(change)
        this.submitted.push({ change, description: input ?? '', client })
        return ok(tag({ submittedChange: change + 1000 }))
      }
      case 'revert':
        return ok()
      default:
        return {
          code: 1,
          stdout: '',
          stderr: `unexpected p4 ${raw.join(' ')}`
        }
    }
  }

  private root(client: string): string {
    return this.clients.get(client)?.root ?? ''
  }

  private clientCommand(rest: string[], input?: string): P4CommandResult {
    if (rest[0] === '-o') {
      return ok(
        `Client:\t${rest.at(-1)}\n\nRoot:\tC:\\nowhere\n\nStream:\t${rest[2]}\n\nView:\n\t//s/main/... //x/...\n`
      )
    }
    if (rest[0] === '-i') {
      const spec = parseP4Spec(input ?? '')
      const name = spec.get('Client')?.[0] ?? ''
      this.clients.set(name, {
        stream: spec.get('Stream')?.[0] ?? '',
        root: spec.get('Root')?.[0] ?? '',
        opened: 0
      })
      return ok(`Client ${name} saved.\n`)
    }
    this.clients.delete(rest[1])
    return ok(`Client ${rest[1]} deleted.\n`)
  }
}

let base: string
let ws: string
let server: CopyUpServer
let host: WorkspaceCopyHost

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4copy-up-'))
  ws = join(base, 'ws')
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'p4config.txt'), 'P4CLIENT=src\n')
  server = new CopyUpServer(ws)
  host = {
    p4: async (args, options) => server.run(args, options.input),
    robocopy: () => Promise.reject(new Error('unused')),
    windowsBuild: () => null,
    freeBytes: () => Promise.resolve(0),
    removeTree: (path) => rm(path, { recursive: true, force: true })
  }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function copyClient(): { stream: string; opened: number } {
  const client = server.clients.get('src_wt_one')
  if (!client) {
    throw new Error('no copy client')
  }
  return client
}

const tempClientGone = (): boolean => !server.clients.has('src_up_one')

describe('previewWorkspaceCopyUp', () => {
  it('lists the files and changes without opening anything, then deletes its client', async () => {
    const preview = await previewWorkspaceCopyUp(host, ws, 'one')
    expect(preview).toMatchObject({
      stream: STREAM,
      parent: '//s/main',
      upToDate: false
    })
    expect(preview.files.map((f) => f.depotFile)).toEqual(server.copyFiles)
    expect(preview.changes.map((c) => c.change)).toEqual([42, 41])
    const copy = server.calls.find((call) => call.includes('copy'))
    expect(copy).toEqual(expect.arrayContaining(['-v', '-Af', '-n', '-S', STREAM]))
    expect(server.submitted).toEqual([])
    expect(tempClientGone()).toBe(true)
  })

  it('reports up to date without making a client', async () => {
    server.istat.integToParent = 'false'
    const preview = await previewWorkspaceCopyUp(host, ws, 'one')
    expect(preview.upToDate).toBe(true)
    expect(server.calls.some((call) => call.includes('-i'))).toBe(false)
  })

  it('refuses when the parent has changes the stream lacks', async () => {
    server.istat.integFromParent = 'true'
    await expect(previewWorkspaceCopyUp(host, ws, 'one')).rejects.toThrow(
      /Merge them into the copy/
    )
  })

  it('refuses while the copy has open files', async () => {
    copyClient().opened = 2
    await expect(previewWorkspaceCopyUp(host, ws, 'one')).rejects.toThrow(
      /2 file\(s\) are still open/
    )
  })

  it('refuses a copy on a shared stream', async () => {
    copyClient().stream = '//s/main'
    await expect(previewWorkspaceCopyUp(host, ws, 'one')).rejects.toThrow(/not a stream of its own/)
  })
})

describe('copyUpWorkspaceCopy', () => {
  it('submits in a throwaway parent client and cleans it up', async () => {
    const result = await copyUpWorkspaceCopy(host, ws, 'one')
    expect(result).toMatchObject({
      parent: '//s/main',
      submittedChange: 1101,
      warnings: []
    })
    expect(result.files).toHaveLength(2)
    expect(server.submitted).toEqual([expect.objectContaining({ client: 'src_up_one' })])
    expect(tempClientGone()).toBe(true)
    expect(server.pending.size).toBe(0)
    const spec = server.calls.find((call) => call[0] === 'client' && call[1] === '-o')
    expect(spec).toEqual(['client', '-o', '-S', '//s/main', 'src_up_one'])
  })

  it('describes the changelist with the stream’s changes unless given one', async () => {
    const changeInput: string[] = []
    const run = server.run.bind(server)
    server.run = (args, input) => {
      if (args.includes('change') && args.includes('-i')) {
        changeInput.push(input ?? '')
      }
      return run(args, input)
    }
    await copyUpWorkspaceCopy(host, ws, 'one')
    expect(changeInput[0]).toContain('- 42: fix the jump')
    await copyUpWorkspaceCopy(host, ws, 'one', { description: 'Ship it' })
    expect(changeInput[1]).toContain('Ship it')
    expect(changeInput[1]).not.toContain('fix the jump')
  })

  it('submits nothing when a file needs a resolve, and still cleans up', async () => {
    server.unresolved = 1
    await expect(copyUpWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/need a resolve/)
    expect(server.submitted).toEqual([])
    expect(tempClientGone()).toBe(true)
    expect(server.pending.size).toBe(0)
  })

  it('clears a leftover client from an earlier run first', async () => {
    server.clients.set('src_up_one', {
      stream: '//s/main',
      root: 'C:\\old',
      opened: 0
    })
    await copyUpWorkspaceCopy(host, ws, 'one')
    expect(server.calls.filter((call) => call[0] === 'client' && call[1] === '-d')).toHaveLength(2)
  })

  it('refuses a leftover client that still has open files', async () => {
    server.clients.set('src_up_one', {
      stream: '//s/main',
      root: 'C:\\old',
      opened: 1
    })
    await expect(copyUpWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/earlier copy-up/)
    expect(server.submitted).toEqual([])
  })

  it('refuses when there is nothing to copy up', async () => {
    server.istat.integToParent = 'false'
    await expect(copyUpWorkspaceCopy(host, ws, 'one')).rejects.toThrow(/nothing to copy up/)
  })

  it('removes its temporary folder', async () => {
    let root = ''
    const run = server.run.bind(server)
    server.run = (args, input) => {
      if (args[0] === 'client' && args[1] === '-i') {
        root = parseP4Spec(input ?? '').get('Root')?.[0] ?? ''
      }
      return run(args, input)
    }
    await copyUpWorkspaceCopy(host, ws, 'one')
    expect(root).not.toBe('')
    expect(existsSync(root)).toBe(false)
  })
})
