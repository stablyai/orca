import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { P4CommandResult, P4RunOptions } from '../../p4-command'
import { formatP4Spec, parseP4Spec } from '../p4-spec'
import {
  fail,
  flushCommand,
  haveCommand,
  missingFilesCommand,
  ok,
  openedCommand,
  syncCommand,
  tag,
  writeRev,
  type FakeClient,
  type FileRev
} from './fake-perforce-files'

export { depotContent } from './fake-perforce-files'

/** An in-memory Perforce server answering exactly the commands the copy engine runs. */
export class FakePerforceServer {
  clients = new Map<string, FakeClient>()
  streams = new Map<string, { parent: string | null; submits: number }>()
  /** Head revisions per stream, keyed by lower-case relative path. */
  heads = new Map<string, Map<string, FileRev>>()
  calls: string[][] = []
  failWhen: ((args: string[]) => boolean) | null = null
  private nextChange = 500

  addStream(stream: string, files: Record<string, number>, parent: string | null = null): void {
    this.streams.set(stream.toLowerCase(), { parent, submits: 0 })
    const head = new Map<string, FileRev>()
    for (const [rel, rev] of Object.entries(files)) {
      head.set(rel.toLowerCase(), { rel, rev })
    }
    this.heads.set(stream.toLowerCase(), head)
  }

  /** A client synced to its stream's head, with the files written under `root`. */
  addSyncedClient(name: string, root: string, stream: string): FakeClient {
    const client: FakeClient = {
      name,
      root,
      stream,
      have: new Map(),
      opened: new Map(),
      pending: []
    }
    for (const [key, file] of this.heads.get(stream.toLowerCase()) ?? []) {
      client.have.set(key, { ...file })
      writeRev(client, file.rel, file.rev)
    }
    this.clients.set(name.toLowerCase(), client)
    return client
  }

  addPending(clientName: string, desc: string, shelvedFiles = 0): number {
    const change = (this.nextChange += 1)
    this.client(clientName)?.pending.push({ change, desc, shelvedFiles })
    return change
  }

  client(name: string): FakeClient | undefined {
    return this.clients.get(name.toLowerCase())
  }

  private configClient(cwd: string): { client: string; path: string } | null {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const path = join(dir, 'p4config.txt')
      if (existsSync(path)) {
        const match = /^P4CLIENT=(\S+)/m.exec(readFileSync(path, 'utf8'))
        return match ? { client: match[1], path } : null
      }
      if (dirname(dir) === dir) {
        return null
      }
    }
  }

  async run(rawArgs: readonly string[], options: P4RunOptions): Promise<P4CommandResult> {
    const args = [...rawArgs]
    this.calls.push([...rawArgs])
    if (this.failWhen?.(args)) {
      return fail(`injected failure: ${args.join(' ')}`)
    }
    let format: string | null = null
    let clientName = this.configClient(options.cwd)?.client ?? ''
    const stdinSpecs = (options.input ?? '').split('\n').filter(Boolean)
    for (;;) {
      if (args[0] === '-ztag' || args[0] === '-q') {
        args.shift()
      } else if (args[0] === '-F' || args[0] === '-c' || args[0] === '-x') {
        const [flag, value] = args.splice(0, 2)
        format = flag === '-F' ? value : format
        clientName = flag === '-c' ? value : clientName
      } else {
        break
      }
    }
    return this.dispatch(args, clientName, format, stdinSpecs, options)
  }

  private dispatch(
    args: string[],
    clientName: string,
    format: string | null,
    stdinSpecs: string[],
    options: P4RunOptions
  ): P4CommandResult {
    const [cmd, ...rest] = args
    const client = this.client(clientName)
    switch (cmd) {
      case 'set': {
        const found = this.configClient(options.cwd)
        return ok(found ? `P4CLIENT=${found.client} (config '${found.path}')\n` : '')
      }
      case 'info':
        return ok(
          tag(
            client
              ? {
                  userName: 'me',
                  clientName: client.name,
                  clientRoot: client.root,
                  clientStream: client.stream
                }
              : { userName: 'me', clientName: '*unknown*' }
          )
        )
      case 'clients': {
        const pattern = rest[1].toLowerCase()
        const match = (name: string): boolean =>
          pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
        return ok(
          [...this.clients.values()]
            .filter((c) => match(c.name.toLowerCase()))
            .map((c) => tag({ client: c.name, Root: c.root, Stream: c.stream }))
            .join('')
        )
      }
      case 'streams': {
        const stream = this.streams.get(rest[0].toLowerCase())
        return ok(stream ? tag({ Stream: rest[0], Parent: stream.parent ?? 'none' }) : '')
      }
      case 'client':
        return this.clientCommand(rest, options)
      case 'stream':
        return this.streamCommand(rest, options)
      case 'opened':
        return client ? openedCommand(client) : fail('no client')
      case 'changes':
        return this.changesCommand(rest)
      case 'describe': {
        const change = Number(rest.at(-1))
        const pending = [...this.clients.values()]
          .flatMap((c) => c.pending)
          .find((p) => p.change === change)
        const files = Object.fromEntries(
          Array.from({ length: pending?.shelvedFiles ?? 0 }, (_, i) => [
            `depotFile${i}`,
            `//s/f${i}`
          ])
        )
        return ok(tag({ change, ...files }))
      }
      case 'have':
      case 'fstat':
        return client ? haveCommand(client, format ?? '', cmd === 'fstat') : fail('no client')
      case 'flush':
        return client
          ? flushCommand(
              client,
              rest.at(-1) ?? '',
              (name) => this.client(name),
              this.headOf(client)
            )
          : fail('no client')
      case 'sync':
        return client ? syncCommand(client, stdinSpecs) : fail('no client')
      case 'diff':
        return client ? missingFilesCommand(client) : fail('no client')
      case 'revert':
        client?.opened.clear()
        return ok()
      case 'shelve': {
        const pending = client?.pending.find((p) => p.change === Number(rest.at(-1)))
        if (pending) {
          pending.shelvedFiles = 0
        }
        return ok()
      }
      case 'change': {
        const change = Number(rest.at(-1))
        const pending = client?.pending.find((p) => p.change === change)
        if (!client || !pending || pending.shelvedFiles > 0) {
          return fail(`Change ${change} cannot be deleted.`)
        }
        client.pending = client.pending.filter((p) => p !== pending)
        return ok(`Change ${change} deleted.\n`)
      }
      default:
        return fail(`fake p4: unsupported command ${args.join(' ')}`)
    }
  }

  private clientCommand(rest: string[], options: P4RunOptions): P4CommandResult {
    if (rest[0] === '-o') {
      const c = this.client(rest[1])
      if (!c) {
        return fail(`no client ${rest[1]}`)
      }
      return ok(
        formatP4Spec(
          new Map([
            ['Client', [c.name]],
            ['Owner', ['me']],
            ['Root', [c.root]],
            ['Options', ['noallwrite clobber']],
            ['SubmitOptions', ['submitunchanged']],
            ['LineEnd', ['local']],
            ['Stream', [c.stream]],
            ['View', [`${c.stream}/... //${c.name}/...`]],
            ['Description', ['Created by me.']]
          ])
        )
      )
    }
    if (rest[0] === '-i') {
      const spec = parseP4Spec(options.input ?? '')
      const name = spec.get('Client')?.[0] ?? ''
      if (spec.has('View') || !spec.get('Stream')?.[0]) {
        return fail('fake p4: a stream client spec must name a Stream and no View')
      }
      this.clients.set(name.toLowerCase(), {
        name,
        root: spec.get('Root')?.[0] ?? '',
        stream: spec.get('Stream')?.[0] ?? '',
        have: new Map(),
        opened: new Map(),
        pending: []
      })
      return ok(`Client ${name} saved.\n`)
    }
    const c = this.client(rest.at(-1) ?? '')
    if (!c || c.opened.size > 0 || c.pending.length > 0) {
      return fail(`Client ${rest.at(-1)} has files opened or pending changes.`)
    }
    this.clients.delete(c.name.toLowerCase())
    return ok(`Client ${c.name} deleted.\n`)
  }

  private streamCommand(rest: string[], options: P4RunOptions): P4CommandResult {
    if (rest[0] === '-o') {
      return ok(
        `Stream:\t${rest.at(-1)}\n\nParent:\t${rest[rest.indexOf('-P') + 1]}\n\nType:\tsparsedev\n\nPaths:\n\tshare ... @300\n`
      )
    }
    if (rest[0] === '-i') {
      const spec = parseP4Spec(options.input ?? '')
      const stream = spec.get('Stream')?.[0] ?? ''
      const parent = spec.get('Parent')?.[0] ?? ''
      const pin = Number(/@(\d+)/.exec(spec.get('Paths')?.[0] ?? '')?.[1])
      if (!Number.isInteger(pin)) {
        return fail('fake p4: sparse stream is not pinned')
      }
      this.addStream(stream, {}, parent)
      this.heads.set(stream.toLowerCase(), new Map(this.heads.get(parent.toLowerCase())))
      return ok(`Stream ${stream} saved.\n`)
    }
    const stream = rest.at(-1) ?? ''
    if ([...this.clients.values()].some((c) => c.stream.toLowerCase() === stream.toLowerCase())) {
      return fail(`Stream ${stream} has active clients.`)
    }
    this.streams.delete(stream.toLowerCase())
    return ok(`Stream ${stream} deleted.\n`)
  }

  private changesCommand(rest: string[]): P4CommandResult {
    const at = rest.at(-1) ?? ''
    if (rest.includes('pending')) {
      const c = this.client(rest[rest.indexOf('-c') + 1])
      return ok((c?.pending ?? []).map((p) => tag({ change: p.change, desc: p.desc })).join(''))
    }
    if (at.endsWith('#have')) {
      return ok(tag({ change: 100 }))
    }
    const key = at.replace(/\/\.\.\.$/, '').toLowerCase()
    const stream = this.streams.get(key)
    if (stream && stream.submits > 0) {
      return ok(tag({ change: 200 }))
    }
    // Like p4: without `-s submitted`, a shelf in a client of the stream is a change there too.
    const shelf = rest.includes('submitted')
      ? undefined
      : [...this.clients.values()]
          .filter((c) => c.stream.toLowerCase() === key)
          .flatMap((c) => c.pending)
          .find((p) => p.shelvedFiles > 0)
    return ok(shelf ? tag({ change: shelf.change }) : '')
  }

  private headOf(client: FakeClient): Map<string, FileRev> {
    return this.heads.get(client.stream.toLowerCase()) ?? new Map()
  }

  /** Client-relative paths of a client's have-list (for assertions). */
  haveOf(name: string): Record<string, number> {
    return Object.fromEntries(
      [...(this.client(name)?.have.values() ?? [])].map((f) => [f.rel, f.rev])
    )
  }
}
