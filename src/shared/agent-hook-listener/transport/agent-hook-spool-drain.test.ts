import { afterEach, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainAgentHookSpoolAsync } from './agent-hook-spool'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-spool-order-'))
  directories.push(endpointDir)
  mkdirSync(join(endpointDir, 'spool'))
  const path = join(endpointDir, 'spool', 'pane.jsonl')
  const line = (event: string) =>
    `${JSON.stringify({ paneKey: 'tab:1', source: 'codex', receivedAt: Date.now(), payload: event })}\n`
  const contents = line('start') + line('tool')
  writeFileSync(path, contents)
  return { endpointDir, path, contents, line, getPersistedLaunchTokenHash: () => undefined }
}

it('retains the complete file after an admission fails', async () => {
  const data = fixture()
  const ingest = vi.fn((record) => {
    if (record.payload === 'tool') {
      throw new Error('admission failed')
    }
  })
  await expect(
    drainAgentHookSpoolAsync({ ...data, ingest: async (record) => ingest(record) })
  ).rejects.toThrow('admission failed')
  expect(readFileSync(data.path, 'utf8')).toBe(data.contents)
  const retried = vi.fn()
  expect(await drainAgentHookSpoolAsync({ ...data, ingest: retried })).toBe(2)
  expect(retried.mock.calls.map(([record]) => record.payload)).toEqual(['start', 'tool'])
  expect(readFileSync(data.path, 'utf8')).toBe('')
})

it('waits for the owner probe before later records and preserves appended records', async () => {
  const data = fixture()
  let release: (() => void) | undefined
  const probe = new Promise<void>((resolve) => {
    release = resolve
  })
  const admitted: unknown[] = []
  const ingest = vi.fn(async (record) => {
    if (record.payload === 'start') {
      await probe
    }
    admitted.push(record.payload)
  })
  const draining = drainAgentHookSpoolAsync({ ...data, ingest })
  expect(ingest).toHaveBeenCalledTimes(1)
  expect(admitted).toEqual([])
  expect(readFileSync(data.path, 'utf8')).toBe(data.contents)
  const appended = data.line('stop')
  appendFileSync(data.path, appended)
  release?.()
  expect(await draining).toBe(2)
  expect(admitted).toEqual(['start', 'tool'])
  expect(readFileSync(data.path, 'utf8')).toBe(appended)
})
