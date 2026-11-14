// @vitest-environment happy-dom

import type * as I18n from '@/i18n/i18n'
import { expect, it, vi } from 'vitest'

import {
  NativeAccountInputs,
  NativeAccountEvidence,
  nativeEvidenceCovers
} from './ai-vault-native-account-index'
import { accountSettings, installAccountFixture } from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
installAccountFixture()

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
