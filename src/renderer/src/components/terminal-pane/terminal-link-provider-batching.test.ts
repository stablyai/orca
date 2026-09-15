import type { ILink } from '@xterm/xterm'
import { expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createProvider,
  createProviderSetup,
  makeBufferLine
} from './terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()

const { storeState } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

it.each([false, true])('batches all cold hover candidates repeated=%s', async (repeated) => {
  const text = Array.from(
    { length: 8 },
    (_, i) => `./${repeated ? 'same' : `file${i}`}.ts:${i + 1}`
  ).join('  ')

  const batch = vi.fn(async (paths: string[]) => paths.map(() => true))
  window.api.shell.pathsExist = batch
  const { provider } = createProviderSetup([makeBufferLine(text)], new Map())

  const links = await new Promise<ILink[]>((resolve) =>
    provider.provideLinks(1, (links) => resolve(links ?? []))
  )

  expect(batch).toHaveBeenCalledTimes(1)
  expect(batch.mock.calls[0][0]).toHaveLength(repeated ? 1 : 8)
  expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  expect(links).toHaveLength(8)
  expect(links.map((link) => link.text)).toEqual(
    Array.from({ length: 8 }, (_, i) => `./${repeated ? 'same' : `file${i}`}.ts:${i + 1}`)
  )
  expect(new Set(links.map((link) => JSON.stringify(link.range))).size).toBe(8)
})

it('preserves warm positive and negative cache answers across hover turns', async () => {
  const batch = vi.fn(async (paths: string[]) => paths.map((path) => !path.endsWith('missing.ts')))
  window.api.shell.pathsExist = batch
  const cache = new Map<string, boolean>()
  const { provider } = createProviderSetup([makeBufferLine('./present.ts ./missing.ts')], cache)

  const hover = () =>
    new Promise<ILink[]>((resolve) => provider.provideLinks(1, (links) => resolve(links ?? [])))

  expect((await hover()).map((link) => link.text)).toEqual(['./present.ts'])
  expect((await hover()).map((link) => link.text)).toEqual(['./present.ts'])
  expect(batch).toHaveBeenCalledTimes(1)
  expect(batch.mock.calls[0][0]).toHaveLength(2)
  expect([...cache.values()].sort()).toEqual([false, true])
})

it('drops stale wrapped links while a batch is pending', async () => {
  const rows = [
    makeBufferLine('open src/components/'),
    makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
  ]

  const exists = createDeferred<boolean[]>()
  const batch = vi.fn(() => exists.promise)
  window.api.shell.pathsExist = batch
  const provider = createProvider(rows)
  const callback = vi.fn()
  provider.provideLinks(1, callback)
  await flushAsyncWork()
  expect(batch).toHaveBeenCalledTimes(1)
  rows[0] = makeBufferLine('changed src/other/')
  exists.resolve([true])
  await flushAsyncWork()
  await flushAsyncWork()
  expect(callback).not.toHaveBeenCalled()
})
