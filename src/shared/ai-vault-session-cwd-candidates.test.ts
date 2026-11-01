import { expect, it, vi } from 'vitest'
import { matchAiVaultSessionCwdCandidates } from './ai-vault-session-cwd-candidates'
import { createNormalizedPathInsideOrEqualMatcher } from './cross-platform-path'

it('keeps alias matching linear in candidate roots at the maximum host alias count', () => {
  const session = {
    filePath: '/session.jsonl',
    cwdAliases: Array.from({ length: 64 }, (_, i) => `/alias-${i}/child`)
  }
  for (const size of [100, 1000]) {
    const owns = vi.fn(createNormalizedPathInsideOrEqualMatcher('/alias-63'))
    const candidates = Array.from({ length: size }, () => ({
      normalizedPath: '/alias-63',
      ownsNormalizedCwd: owns
    }))
    expect(
      matchAiVaultSessionCwdCandidates(session, '/physical/child', candidates, () => 0)
    ).toHaveLength(size)
    expect(owns).toHaveBeenCalledTimes(size * 65)
  }
})
