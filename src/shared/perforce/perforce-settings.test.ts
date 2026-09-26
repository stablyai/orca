import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { P4NotFoundError, resetP4BinaryCacheForTests, runP4 } from './p4-command'
import { runWithPerforceSettings } from './p4-settings-context'
import { localPerforceBackend } from './perforce-backend'
import { clearPerforceDetectCache } from './perforce-detection'
import {
  DEFAULT_PERFORCE_SETTINGS,
  applyChangelistTemplate,
  normalizePerforceSettings,
  perforceEnvOverrides,
  perforceSectionOrder,
  type PerforceSettings
} from './perforce-settings'

describe('normalizePerforceSettings', () => {
  it('returns defaults for missing or malformed input', () => {
    expect(normalizePerforceSettings(undefined)).toEqual(DEFAULT_PERFORCE_SETTINGS)
    expect(normalizePerforceSettings('nope')).toEqual(DEFAULT_PERFORCE_SETTINGS)
  })

  it('clamps numbers, rejects unknown choices and trims text', () => {
    const settings = normalizePerforceSettings({
      p4Port: '  ssl:srv:1666  ',
      commandTimeoutSeconds: 1,
      statusScanTimeoutSeconds: 99999,
      refreshIntervalSeconds: 0,
      groupOrder: 'bogus',
      compareAgainst: 'head',
      saveReadOnlyBehavior: 'sometimes',
      confirmSubmit: 'yes'
    })
    expect(settings.p4Port).toBe('ssl:srv:1666')
    expect(settings.commandTimeoutSeconds).toBe(5)
    expect(settings.statusScanTimeoutSeconds).toBe(3600)
    expect(settings.refreshIntervalSeconds).toBe(0)
    expect(settings.groupOrder).toBe('default-first')
    expect(settings.compareAgainst).toBe('head')
    expect(settings.saveReadOnlyBehavior).toBe('ask')
    expect(settings.confirmSubmit).toBe(false)
  })

  it('keeps an empty ignore file name from disabling the default', () => {
    expect(normalizePerforceSettings({ ignoreFileName: '  ' }).ignoreFileName).toBe('.p4ignore')
  })
})

describe('settings helpers', () => {
  it('places every section exactly once for each order', () => {
    for (const order of ['default-first', 'numbered-first', 'unopened-first'] as const) {
      expect([...perforceSectionOrder(order)].sort()).toEqual([
        'default',
        'modified',
        'new',
        'numbered'
      ])
    }
    expect(perforceSectionOrder('numbered-first')[0]).toBe('numbered')
    expect(perforceSectionOrder('unopened-first')[0]).toBe('modified')
  })

  it('only overrides environment variables the user filled in', () => {
    expect(perforceEnvOverrides(DEFAULT_PERFORCE_SETTINGS)).toEqual({})
    expect(
      perforceEnvOverrides({
        ...DEFAULT_PERFORCE_SETTINGS,
        p4Port: 'srv:1666',
        p4Config: '.p4config',
        useIgnoreFile: true
      })
    ).toEqual({ P4PORT: 'srv:1666', P4CONFIG: '.p4config', P4IGNORE: '.p4ignore' })
  })

  it('fills template placeholders', () => {
    expect(applyChangelistTemplate('[{user}@{client}] ', { user: 'me', client: 'ws' })).toBe(
      '[me@ws] '
    )
    expect(applyChangelistTemplate('{user}', {})).toBe('')
  })
})

const FAKE_P4 = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2).filter((a) => a !== '-ztag')
fs.appendFileSync(process.env.FAKE_P4_LOG, JSON.stringify({ args, port: process.env.P4PORT ?? null }) + '\\n')
const root = process.env.FAKE_P4_ROOT
const out = (text) => process.stdout.write(text)
const [cmd] = args
if (cmd === 'info') out('... clientName ws\\n... userName me\\n... serverAddress srv:1666\\n... clientRoot ' + root + '\\n')
else if (cmd === 'reconcile') out('... clientFile ' + root + '/n.txt\\n... action add\\n')
else if (cmd === 'changes' && args.includes('pending')) out('')
`

describe.skipIf(process.platform === 'win32')('settings applied to p4 calls', () => {
  let dir: string
  let log: string
  const previous = { ...process.env }

  async function invocations(): Promise<{ args: string[]; port: string | null }[]> {
    return (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  const withSettings = <T>(patch: Partial<PerforceSettings>, run: () => Promise<T>): Promise<T> =>
    runWithPerforceSettings({ ...DEFAULT_PERFORCE_SETTINGS, ...patch }, run)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-p4-settings-'))
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
    process.env = { ...previous }
    resetP4BinaryCacheForTests()
    clearPerforceDetectCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('passes connection overrides to p4', async () => {
    await withSettings({ p4Port: 'override:1666' }, () => runP4(['info'], { cwd: dir }))
    expect((await invocations())[0]?.port).toBe('override:1666')
  })

  it('uses the configured p4 path and reports a bad one', async () => {
    const bin = join(dir, 'other-p4')
    await writeFile(bin, FAKE_P4)
    await chmod(bin, 0o755)
    await withSettings({ p4Path: bin }, () => runP4(['info'], { cwd: dir }))
    expect(await invocations()).toHaveLength(1)
    await expect(
      withSettings({ p4Path: join(dir, 'missing') }, () => runP4(['info'], { cwd: dir }))
    ).rejects.toBeInstanceOf(P4NotFoundError)
  })

  it('skips the reconcile scan when both unopened sections are hidden', async () => {
    const status = await withSettings({ showModifiedNotOpened: false, showNewFiles: false }, () =>
      localPerforceBackend.status(dir)
    )
    expect(status.entries).toEqual([])
    expect((await invocations()).some((call) => call.args[0] === 'reconcile')).toBe(false)
  })

  it('previews only new files when modified files are hidden', async () => {
    await withSettings({ showModifiedNotOpened: false }, () => localPerforceBackend.status(dir))
    const reconcile = (await invocations()).find((call) => call.args[0] === 'reconcile')
    expect(reconcile?.args).toEqual(['reconcile', '-n', '-a', '...'])
  })

  it('diffs against the depot head when configured', async () => {
    await withSettings({ compareAgainst: 'head' }, () => localPerforceBackend.diff(dir, 'a.txt'))
    const print = (await invocations()).find((call) => call.args[0] === 'print')
    expect(print?.args.at(-1)).toBe('a.txt#head')
  })
})
