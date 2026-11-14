import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { P4CommandResult } from '../../p4-command'

export type FileRev = { rel: string; rev: number }

export type FakeClient = {
  name: string
  root: string
  stream: string
  have: Map<string, FileRev>
  opened: Map<string, { rel: string; action: string }>
  pending: { change: number; desc: string; shelvedFiles: number }[]
}

export const ok = (stdout = '', stderr = ''): P4CommandResult => ({ code: 0, stdout, stderr })

export const fail = (stderr: string): P4CommandResult => ({ code: 1, stdout: '', stderr })

export const tag = (record: Record<string, string | number>): string =>
  `${Object.entries(record)
    .map(([k, v]) => `... ${k} ${v}`)
    .join('\n')}\n\n`

/** File content a depot revision syncs to; the same revision has the same content on every stream. */
export function depotContent(rel: string, rev: number): string {
  return `${rel}#${rev}`
}

export function writeRev(client: FakeClient, rel: string, rev: number): void {
  const path = join(client.root, ...rel.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, depotContent(rel, rev))
}

/** `have` and `fstat -Olp` under `-ztag -F`: one formatted line per have revision. */
export function haveCommand(client: FakeClient, format: string, digests: boolean): P4CommandResult {
  const lines = [...client.have.values()].map((file) => {
    const value = digests
      ? createHash('md5').update(depotContent(file.rel, file.rev)).digest('hex')
      : String(file.rev)
    return format
      .replace('%clientFile%', `//${client.name}/${file.rel}`)
      .replace(/%(haveRev|digest)%/, value)
  })
  return ok(lines.map((line) => `${line}\n`).join(''))
}

/** `flush //c/...@other` copies another client's have-list; no revision means the stream head. */
export function flushCommand(
  client: FakeClient,
  spec: string,
  findClient: (name: string) => FakeClient | undefined,
  head: Map<string, FileRev>
): P4CommandResult {
  const revision = /\/\.\.\.(@.+)?$/.exec(spec)?.[1] ?? ''
  const from = revision.startsWith('@') ? findClient(revision.slice(1)) : undefined
  const files = from ? from.have : head
  client.have = new Map([...files].map(([k, v]) => [k, { ...v }]))
  return ok()
}

/** `-x - sync -f` of `//c/file#have` and `//c/dir/...#have` specs. */
export function syncCommand(client: FakeClient, specs: string[]): P4CommandResult {
  const out: string[] = []
  const errors: string[] = []
  for (const spec of specs) {
    const rel = spec.slice(`//${client.name}/`.length).replace(/#have$/, '')
    const matches = rel.endsWith('/...')
      ? [...client.have.values()].filter((f) =>
          f.rel.toLowerCase().startsWith(rel.slice(0, -3).toLowerCase())
        )
      : [client.have.get(rel.toLowerCase())].filter((f) => f !== undefined)
    if (matches.length === 0) {
      errors.push(`${spec} - file(s) not on client.`)
    }
    for (const file of matches) {
      writeRev(client, file.rel, file.rev)
      out.push(`//s/${file.rel}#${file.rev} - refreshing ${join(client.root, file.rel)}`)
    }
  }
  return ok(out.join('\n'), errors.join('\n'))
}

/** `diff -sd`: local paths of have-list files missing on disk. */
export function missingFilesCommand(client: FakeClient): P4CommandResult {
  const missing = [...client.have.values()]
    .map((file) => join(client.root, ...file.rel.split('/')))
    .filter((path) => !existsSync(path))
  return ok(missing.map((path) => `${path}\n`).join(''))
}

export function openedCommand(client: FakeClient): P4CommandResult {
  if (client.opened.size === 0) {
    return fail('File(s) not opened on this client.')
  }
  return ok(
    [...client.opened.values()]
      .map((o) => tag({ clientFile: `//${client.name}/${o.rel}`, action: o.action }))
      .join('')
  )
}
