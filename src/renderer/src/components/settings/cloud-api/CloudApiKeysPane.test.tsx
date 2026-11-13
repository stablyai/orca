// @vitest-environment happy-dom
// The Orca API keys pane for a team WITHOUT the Enterprise plan. Key activity lives only in the
// Enterprise audit log now, so this pane must never call an audit route (the control plane
// refuses those without the entitlement) and must never show an error because of one.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  CloudApiKeyList,
  CloudApiMe,
  CloudApiResult
} from '../../../../../shared/cloud-api/cloud-api-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CloudApiKeysPane } from './CloudApiKeysPane'

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A fixed clock, so "5 minutes ago" never depends on when the test runs.
const NOW = Date.UTC(2026, 10, 12, 17, 30)
const ME: CloudApiMe = {
  accountId: 'org:acme',
  userId: 'u_ada',
  orgId: 'acme',
  role: 'owner',
  scopes: ['workspaces:read', 'workspaces:write', 'audit:read']
}
const KEYS: CloudApiKeyList = {
  availableScopes: ['workspaces:read', 'workspaces:write', 'audit:read'],
  keys: [
    {
      id: 'key_ci',
      name: 'GitHub Actions deploy',
      prefix: 'orca_sk_Ab3x',
      scopes: ['workspaces:read'],
      createdBy: 'u_ada',
      createdByName: 'Ada Lovelace',
      createdAt: NOW - 3 * 86_400_000,
      lastUsedAt: NOW - 5 * 60_000,
      expiresAt: null
    }
  ]
}

const ok = <T,>(data: T): Promise<CloudApiResult<T>> => Promise.resolve({ ok: true, data })

/**
 * The bridge as a non-Enterprise team's control plane answers it: everything the pane needs
 * works, and ANY audit read is refused for the plan. Every call is recorded by name.
 */
function nonEnterpriseBridge(): { api: Record<string, unknown>; calls: string[] } {
  const calls: string[] = []
  const known: Record<string, () => unknown> = {
    availability: () =>
      Promise.resolve({ status: 'ready', controlPlaneUrl: 'https://api.orca.dev' }),
    me: () => ok(ME),
    listApiKeys: () => ok(KEYS),
    getSettings: () => ok({ settings: { vmCliEnabled: true }, canEdit: true }),
    listGrants: () => ok({ grants: [] })
  }
  const api = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => {
          calls.push(name)
          void args
          return (
            known[name]?.() ??
            Promise.resolve({ ok: false, error: 'plan-required', detail: 'audit_log' })
          )
        }
      }
    }
  )
  return { api, calls }
}

it('lists the keys with their last use, makes no audit call and shows no error for a non-Enterprise team', async () => {
  const { api, calls } = nonEnterpriseBridge()
  // The pane reads window.api (happy-dom's window is the test global).
  vi.stubGlobal('api', { cloudApi: api, shell: { openUrl: vi.fn() } })

  const { container } = render(
    <TooltipProvider>
      <CloudApiKeysPane />
    </TooltipProvider>
  )
  await waitFor(() => expect(screen.getByText('GitHub Actions deploy')).toBeTruthy())

  // The keys list and each key's "last used" stay.
  expect(container.textContent).toMatch(/5 minutes ago/)
  // No activity list, no way to ask for one, and nothing that reads as a failure.
  expect(container.textContent).not.toMatch(/Recent activity|Show activity|Audit log/)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.textContent).not.toMatch(/doesn’t include|permission|Try again|problem/i)
  // Not one audit read, gated or otherwise.
  expect(calls.filter((name) => /audit/i.test(name))).toEqual([])
  expect([...new Set(calls)].sort()).toEqual([
    'availability',
    'getSettings',
    'listApiKeys',
    'listGrants',
    'me'
  ])
})
