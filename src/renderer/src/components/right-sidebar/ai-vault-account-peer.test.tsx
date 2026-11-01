// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { accountWorkCounters } from './ai-vault-account-work-test-fixture'
import { nativeClient, changeSettings } from './ai-vault-account-native-test-fixture'
import {
  NativeAccountInputs,
  NativeAccountEvidence,
  nativeEvidenceCovers
} from './ai-vault-native-account-index'
import {
  accountSettings,
  recordedSession,
  accountCards,
  accountRenders,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
installAccountFixture()

it.each([
  { group: 10, collisions: 10 },
  { group: 100, collisions: 10 },
  { group: 10, collisions: 100 },
  { group: 100, collisions: 100 }
])(
  'shares G=$group peer and C=$collisions candidate edges and equal display evidence',
  async ({ group, collisions }) => {
    const settings = accountSettings(Math.max(group + 2, collisions))
    settings.codexManagedAccounts = settings.codexManagedAccounts.map((a, i) => ({
      ...a,
      email: i < group - 1 ? 'shared@example.com' : `saved-${i}@example.com`
    }))
    useAppStore.setState({ settings })
    const client = nativeClient(settings)
    const live = settings.codexManagedAccounts
      .slice(0, group)
      .map((a) => ({ ...a, email: 'shared@example.com' }))
    // The final live peer's saved email differs; its scoped proof is still consumed.
    const absentPeer = { ...live[0]!, id: 'absent-host-peer' }
    const snapshot = () => ({
      accounts: [...live.map((a) => ({ ...a })), { ...absentPeer }],
      activeAccountId: null
    })
    client.setCodex(snapshot())
    const homes = settings.claudeManagedAccounts
      .slice(0, collisions)
      .map((a) => ({ ...a, home: '/shared/home' }))
    client.setClaude({ accounts: homes, activeAccountId: null })
    const metrics = accountWorkCounters()
    const c = {
      ...recordedSession('claude'),
      id: 'routed',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/shared/home' }
    }
    const sessions = [c, ...Array.from({ length: 3 }, (_, i) => recordedSession('codex', i))]
    const panel = render(accountCards(sessions))
    await flushAccountWork()
    expect(panel.getByTestId('routed').textContent).toContain(homes[0]!.email)
    const originalLabels = sessions.slice(1).map((s) => panel.getByTestId(s.id).textContent)
    const quietCodex = () => {
      expect(metrics.work.helpers).toBe(0)
      expect(metrics.work.helperMembers).toBe(0)
      expect(metrics.work.helperFields).toBe(0)
      for (const [i, session] of sessions.slice(1).entries()) {
        expect(panel.getByTestId(session.id).textContent).toBe(originalLabels[i])
        expect(accountRenders.get(session.id) ?? 0).toBe(0)
      }
    }
    metrics.reset()
    accountRenders.clear()
    // Relevant Claude refresh returns a newly allocated equal roster in a different peer order.
    client.setCodex({
      accounts: snapshot().accounts.toReversed(),
      activeAccountId: 'irrelevant-selection'
    })
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
        i === 0 ? { ...a, lastAuthenticatedAt: 2 } : a
      )
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(2)
    quietCodex()
    expect(metrics.work.resolutions).toBe(2)
    expect(metrics.work.notifications).toBe(2)
    expect(metrics.work.displayMembers).toBe(settings.claudeManagedAccounts.length + group + 1)
    expect(metrics.work.comparedMembers).toBeLessThanOrEqual(
      4 * settings.claudeManagedAccounts.length + 2 * group + 30
    )
    expect(metrics.work.edges).toBeLessThanOrEqual(2 * collisions + 2)
    metrics.reset()
    accountRenders.clear()
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a) => ({ ...a }))
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(2)
    quietCodex()
    expect(metrics.work.edges).toBeLessThanOrEqual(2 * collisions)
    expect(metrics.work.edgeWalks).toBe(2)
    expect(metrics.work.comparedMembers).toBeLessThanOrEqual(
      4 * settings.claudeManagedAccounts.length + 4 * collisions + 10
    )
    // A formerly absent scoped peer acquired only in WSL is still absent on host.
    metrics.reset()
    accountRenders.clear()
    await changeSettings((s) => ({
      ...s,
      codexManagedAccounts: [
        ...s.codexManagedAccounts,
        {
          ...absentPeer,
          managedHomePath: '/wsl-only',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Debian'
        }
      ]
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(2)
    quietCodex()
    expect(metrics.work.edges).toBeLessThanOrEqual(2 * (group + 1))
    expect(metrics.work.edgeWalks).toBeLessThanOrEqual(2)
    // An unrelated group's proof changes; both touched shared peer projections are walked once.
    metrics.reset()
    accountRenders.clear()
    await changeSettings((s) => ({
      ...s,
      codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
        i === group + 1 ? { ...a, lastAuthenticatedAt: 3 } : a
      )
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(2)
    quietCodex()
    expect(metrics.work.edges).toBeLessThanOrEqual(2 * (group + 1))
    expect(metrics.work.edgeWalks).toBeLessThanOrEqual(2)
    expect(metrics.work.comparedMembers).toBeLessThanOrEqual(10 * group + 30)
    // Live peer -> saved proof joins include the peer with a divergent saved email.
    metrics.reset()
    await changeSettings((s) => ({
      ...s,
      codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
        i === group - 1 ? { ...a, lastAuthenticatedAt: 4 } : a
      )
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(3)
    expect(metrics.work.helpers).toBeGreaterThan(0)
    expect(metrics.work.helperMembers).toBeGreaterThanOrEqual(3 * (group - 1))
    expect(metrics.work.helperFields).toBeGreaterThanOrEqual(metrics.work.helperMembers)
    // Only collision-sensitive ordering is a native wake; first matching routed summary still wins.
    client.setClaude({ accounts: homes.toReversed(), activeAccountId: null })
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
        i === collisions - 1 ? { ...a, updatedAt: 20 } : a
      )
    }))
    expect(client.claudeList).toHaveBeenCalledTimes(4)
    expect(panel.getByTestId('routed').textContent).toContain(homes.at(-1)!.email)
    // Changing the first matching live Codex ID summary is significant, unlike a peer permutation.
    const winner = { ...live[0]!, email: 'winner@example.com', workspaceLabel: 'Work' }
    client.setCodex({ accounts: [winner, ...snapshot().accounts], activeAccountId: null })
    await changeSettings((s) => ({
      ...s,
      codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
        i === 0 ? { ...a, lastAuthenticatedAt: 5 } : a
      )
    }))
    expect(panel.getByTestId('codex-0').textContent).toContain('winner@example.com (Work)')
    const reads = client.codexList.mock.calls.length
    client.setCodex({ accounts: [...snapshot().accounts, winner], activeAccountId: null })
    await changeSettings((s) => ({
      ...s,
      codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
        i === 0 ? { ...a, updatedAt: 40 } : a
      )
    }))
    expect(client.codexList).toHaveBeenCalledTimes(reads + 1)
    expect(panel.getByTestId('codex-0').textContent).toContain('shared@example.com')
  }
)

it('compares real coverage under the same evidence across ordered candidates and A/B/A roots', () => {
  const settings = accountSettings(4)
  const saved = settings.claudeManagedAccounts[0]!
  const candidates = [
    { ...saved },
    { ...saved, managedAuthPath: '/other', email: 'other@example.com' }
  ]
  const a = new NativeAccountInputs({ ...settings, claudeManagedAccounts: candidates })
  const evidence = new NativeAccountEvidence(a, {
    claude: {
      accounts: [
        { ...saved, email: 'old-first@example.com' },
        { ...saved, email: 'old-second@example.com' }
      ],
      activeAccountId: null
    }
  })
  const binding = { kind: 'claude' as const, path: saved.managedAuthPath, scope: 'host' }
  const b = new NativeAccountInputs({
    ...settings,
    claudeManagedAccounts: candidates.toReversed()
  })
  expect(nativeEvidenceCovers(binding, b, evidence)).toBe(false)
  const again = new NativeAccountInputs(
    { ...settings, claudeManagedAccounts: candidates.map((account) => ({ ...account })) },
    b
  )
  expect(nativeEvidenceCovers(binding, again, evidence)).toBe(true)
  const orderOnly = new NativeAccountInputs({
    ...settings,
    claudeManagedAccounts: candidates.map((account, i) => ({ ...account, updatedAt: i + 2 }))
  })
  expect(nativeEvidenceCovers(binding, orderOnly, evidence)).toBe(false)
  const modern = new NativeAccountEvidence(a, {
    claude: {
      accounts: [
        { ...saved, home: '/routed' },
        { ...candidates[1]!, id: 'other', home: '/routed' }
      ],
      activeAccountId: null
    }
  })
  const routed = { ...binding, path: '/routed' }
  expect(nativeEvidenceCovers(routed, orderOnly, modern)).toBe(false)
  const codex = settings.codexManagedAccounts[0]!
  const firstPath = [codex, { ...codex, id: 'other', email: 'other@example.com' }]
  const paths = new NativeAccountInputs({ ...settings, codexManagedAccounts: firstPath })
  const pathEvidence = new NativeAccountEvidence(paths, {
    codex: { accounts: firstPath, activeAccountId: null }
  })
  const swapped = new NativeAccountInputs({
    ...settings,
    codexManagedAccounts: firstPath.toReversed()
  })
  expect(
    nativeEvidenceCovers(
      { kind: 'codex', scope: 'host', path: codex.managedHomePath },
      swapped,
      pathEvidence
    )
  ).toBe(false)
})
