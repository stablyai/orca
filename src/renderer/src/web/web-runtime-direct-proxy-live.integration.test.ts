import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { parseWebPairingInput, type WebPairingOffer } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'

const pairingInput = process.env.ORCA_REMOTE_ACCESS_PAIRING_INPUT
const proxyEndpoint = process.env.ORCA_REMOTE_ACCESS_PROXY_ENDPOINT
const secondPairingInput = process.env.ORCA_REMOTE_ACCESS_SECOND_PAIRING_INPUT

function requireResult<T>(response: RuntimeRpcResponse<unknown>): T {
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result as T
}

async function openClient(offer: WebPairingOffer): Promise<WebRuntimeClient> {
  const client = new WebRuntimeClient(offer)
  requireResult(await client.call('status.get', undefined, { timeoutMs: 15_000 }))
  return client
}

async function ensureTestRepo(client: WebRuntimeClient): Promise<Repo> {
  const listed = requireResult<{ repos: Repo[] }>(await client.call('repo.list'))
  const existing = listed.repos.find((repo) => repo.path === '/app')
  if (existing) {
    return existing
  }
  return requireResult<{ repo: Repo }>(await client.call('repo.add', { path: '/app', kind: 'git' }))
    .repo
}

async function exerciseCatalogAndFilesystem(client: WebRuntimeClient): Promise<void> {
  const repo = await ensureTestRepo(client)
  const listed = requireResult<{ worktrees: Worktree[] }>(
    await client.call('worktree.list', { repo: repo.id, limit: 10_000 })
  )
  expect(listed.worktrees.length).toBeGreaterThan(0)
  const worktree = listed.worktrees[0]
  expect(worktree.hostId ?? 'local').toBe('local')

  const preview = requireResult<{ content: string }>(
    await client.call('files.readPreview', {
      worktree: `id:${worktree.id}`,
      relativePath: 'package.json'
    })
  )
  expect(preview.content).toContain('"name": "orca"')

  const ports = requireResult<WorkspacePortScanResult>(await client.call('workspacePorts.scan', {}))
  expect(Array.isArray(ports.ports)).toBe(true)
}

describe.runIf(Boolean(pairingInput && proxyEndpoint))(
  'paired web runtime over direct and reverse-proxy paths',
  () => {
    let directOffer: WebPairingOffer
    const clients: WebRuntimeClient[] = []

    beforeEach(() => {
      const parsed = parseWebPairingInput(pairingInput ?? '')
      if (!parsed) {
        throw new Error('ORCA_REMOTE_ACCESS_PAIRING_INPUT is not a valid pairing input.')
      }
      directOffer = parsed
      Reflect.set(globalThis, 'window', {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        atob,
        btoa
      })
    })

    afterEach(() => {
      for (const client of clients) {
        client.close()
      }
      clients.length = 0
      Reflect.deleteProperty(globalThis, 'window')
    })

    it('keeps direct and TLS-proxied clients functional across reconnects', async () => {
      const direct = await openClient(directOffer)
      clients.push(direct)
      await exerciseCatalogAndFilesystem(direct)

      const proxy = await openClient({ ...directOffer, endpoint: proxyEndpoint ?? '' })
      clients.push(proxy)
      await exerciseCatalogAndFilesystem(proxy)

      direct.close()
      const reconnected = await openClient(directOffer)
      clients.push(reconnected)
      await exerciseCatalogAndFilesystem(reconnected)
    })

    it('serves independent simultaneous clients over both paths', async () => {
      const [direct, proxy] = await Promise.all([
        openClient(directOffer),
        openClient({ ...directOffer, endpoint: proxyEndpoint ?? '' })
      ])
      clients.push(direct, proxy)

      const results = await Promise.all([direct.call('repo.list'), proxy.call('repo.list')])
      expect(
        results.map((response) => requireResult<{ repos: Repo[] }>(response).repos.length)
      ).toEqual([expect.any(Number), expect.any(Number)])
    })

    it.runIf(Boolean(secondPairingInput))(
      'keeps simultaneous clients to different servers isolated',
      async () => {
        const secondOffer = parseWebPairingInput(secondPairingInput ?? '')
        if (!secondOffer) {
          throw new Error('ORCA_REMOTE_ACCESS_SECOND_PAIRING_INPUT is not valid.')
        }
        const [first, second] = await Promise.all([
          openClient(directOffer),
          openClient(secondOffer)
        ])
        clients.push(first, second)

        const statuses = await Promise.all([
          first.call('status.get', undefined, { timeoutMs: 15_000 }),
          second.call('status.get', undefined, { timeoutMs: 15_000 })
        ])
        expect(new Set(statuses.map((status) => status._meta?.runtimeId)).size).toBe(2)
        await Promise.all([
          exerciseCatalogAndFilesystem(first),
          exerciseCatalogAndFilesystem(second)
        ])
      }
    )
  }
)
