import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetP4BinaryCacheForTests } from './p4-command'
import { localPerforceBackend } from './perforce-backend'
import { clearPerforceDetectCache } from './perforce-detection'
import { parseShelvedFiles } from './perforce-status'

// A stand-in `p4` that logs every invocation and answers with canned tagged output.
const FAKE_P4 = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2).filter((a) => a !== '-ztag')
fs.appendFileSync(process.env.FAKE_P4_LOG, JSON.stringify(args) + '\\n')
const root = process.env.FAKE_P4_ROOT
const out = (text) => process.stdout.write(text)
const [cmd] = args
if (cmd === 'info') out('... clientName ws\\n... userName me\\n... serverAddress srv:1666\\n... clientRoot ' + root + '\\n')
else if (cmd === 'fstat') out('... depotFile //d/a.txt\\n... clientFile ' + root + '/a.txt\\n... action edit\\n... change 12\\n')
else if (cmd === 'reconcile') out('... clientFile ' + root + '/n.txt\\n... action add\\n')
else if (cmd === 'changes' && args.includes('pending')) out('... change 12\\n... desc Fix things\\n')
else if (cmd === 'describe') out('... change 12\\n... depotFile0 //d/s.txt\\n... action0 edit\\n')
else if (cmd === 'client') out('... Stream //d/main\\n')
else if (cmd === 'change' && args[1] === '-o') out('Change:\\t12\\n\\nDescription:\\n\\told\\n\\nFiles:\\n\\t//d/a.txt\\t# edit\\n')
else if (cmd === 'change' && args[1] === '-i') { fs.writeFileSync(process.env.FAKE_P4_LOG + '.stdin', fs.readFileSync(0, 'utf8')); out('Change 12 updated.\\n') }
`

describe.skipIf(process.platform === 'win32')('localPerforceBackend with a fake p4', () => {
  let dir: string
  let log: string
  const previous = { ...process.env }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-p4-'))
    log = join(dir, 'log')
    await writeFile(log, '')
    const bin = join(dir, 'p4')
    await writeFile(bin, FAKE_P4)
    await chmod(bin, 0o755)
    process.env.ORCA_P4_PATH = bin
    process.env.FAKE_P4_LOG = log
    process.env.FAKE_P4_ROOT = dir
    resetP4BinaryCacheForTests()
    clearPerforceDetectCache()
  })

  afterEach(async () => {
    process.env = previous
    await rm(dir, { recursive: true, force: true })
  })

  const invocations = async (): Promise<string[][]> =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line): string[] => {
        const parsed: unknown = JSON.parse(line)
        return Array.isArray(parsed) ? parsed.map(String) : []
      })

  it('builds status from opened files, reconcile preview, and shelves', async () => {
    const status = await localPerforceBackend.status(dir)
    expect(status.info).toMatchObject({ client: 'ws', stream: '//d/main' })
    expect(status.entries.map((e) => [e.path, e.group, e.changelist])).toEqual([
      ['a.txt', 'opened', 12],
      ['n.txt', 'new', undefined]
    ])
    expect(status.changelists).toEqual([
      {
        id: 12,
        description: 'Fix things',
        shelvedFiles: [{ depotPath: '//d/s.txt', action: 'edit' }]
      }
    ])
  })

  it('edits a changelist description while keeping its file list', async () => {
    const result = await localPerforceBackend.editDescription(dir, 12, 'New words')
    expect(result.success).toBe(true)
    const spec = await readFile(`${log}.stdin`, 'utf8')
    expect(spec).toContain('Description:\n\tNew words')
    expect(spec).toContain('//d/a.txt')
    expect(spec).not.toContain('\told')
  })

  it('unshelves into the same changelist and can delete the shelf', async () => {
    await localPerforceBackend.unshelve(dir, 12)
    await localPerforceBackend.deleteShelf(dir, 12)
    const calls = await invocations()
    expect(calls).toContainEqual(['unshelve', '-f', '-s', '12', '-c', '12'])
    expect(calls).toContainEqual(['shelve', '-d', '-c', '12'])
  })

  it('submits the default changelist with a description and numbered ones by id', async () => {
    await localPerforceBackend.submit(dir, 'default', 'Do it')
    await localPerforceBackend.submit(dir, 12)
    const calls = await invocations()
    expect(calls).toContainEqual(['submit', '-d', 'Do it'])
    expect(calls).toContainEqual(['submit', '-c', '12'])
  })
})

describe('parseShelvedFiles', () => {
  it('ignores changelists that have no shelved files', () => {
    const out = '... change 5\n... desc x\n\n... change 6\n... depotFile0 //d/a\n... action0 add\n'
    expect([...parseShelvedFiles(out).keys()]).toEqual([6])
  })
})
