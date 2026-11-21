import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pathEnvRelativeTo,
  resolveCliCommand,
  resolveCliCommands,
  withCliRuntimeOnPath
} from './node-cli-command-resolution'

let rootDir: string
let emptyHome: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'orca-node-cli-resolution-'))
  emptyHome = join(rootDir, 'home')
  await mkdir(emptyHome, { recursive: true })
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

async function writeRuntimePairedCli(): Promise<{ binDir: string; cliPath: string }> {
  const binDir = join(rootDir, 'nvm v20')
  await mkdir(binDir, { recursive: true })
  const cliPath = join(binDir, 'codex.cmd')
  await writeFile(cliPath, '@echo off\r\n')
  await writeFile(join(binDir, 'node.exe'), 'stub')
  return { binDir, cliPath }
}

describe('Windows quoted PATH handling in node-cli-command-resolution', () => {
  it('resolves a Windows CLI from quoted PATH entries', async () => {
    const firstDir = join(rootDir, 'empty bin')
    const quotedDir = join(rootDir, 'Program Files', 'nodejs')
    await mkdir(firstDir, { recursive: true })
    await mkdir(quotedDir, { recursive: true })
    const expected = join(quotedDir, 'orca-test-cli.cmd')
    await writeFile(expected, '@echo off\r\n')

    const pathEnv = `"${firstDir}"${delimiter}"${quotedDir}"`
    const options = { platform: 'win32' as const, pathEnv, homePath: emptyHome }

    expect(resolveCliCommand('orca-test-cli', options)).toBe(expected)
    expect(resolveCliCommands(['orca-test-cli'], options).get('orca-test-cli')).toBe(expected)
  })

  it('keeps quoted absolute Windows PATH entries intact', () => {
    expect(
      pathEnvRelativeTo(
        '"C:\\Program Files\\nodejs";"tools\\bin";C:\\Windows\\System32;',
        'C:\\repo',
        'win32'
      )
    ).toBe('C:\\Program Files\\nodejs;C:\\repo\\tools\\bin;C:\\Windows\\System32')
  })

  it('recognizes a quoted leading runtime directory in withCliRuntimeOnPath', async () => {
    const { binDir, cliPath } = await writeRuntimePairedCli()

    const env = { Path: `"${binDir}";C:\\Windows\\System32` }

    expect(withCliRuntimeOnPath(cliPath, env, { platform: 'win32' })).toBe(env)
  })

  it('drops an alternate-case PATH twin even when the runtime folder already leads', async () => {
    const { binDir, cliPath } = await writeRuntimePairedCli()

    const env = { Path: `"${binDir}";C:\\Windows`, PATH: 'C:\\nvm\\v22;C:\\Windows' }

    expect(withCliRuntimeOnPath(cliPath, env, { platform: 'win32' })).toEqual({
      Path: `${binDir};C:\\Windows`
    })
  })
})
