import '../../../src/main/ai-vault-search/session-search-service'
import '../../../src/main/ai-vault-search/query/session-search-engine-test-fixture'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../src/shared/ai-vault/search/ai-vault-search-client'
import '../../../src/shared/ai-vault/contracts/ai-vault-types'
import '../../../src/shared/ai-vault/search/ai-vault-search-test-fixture'
import { setSessionSearchService } from '../../../src/main/ai-vault-search/session-search-service-registry'
import './release-checkout'
import './release-fixture-setup'

afterEach(() => setSessionSearchService(null))

test.each(['runtime', 'relay'] as const)(
  'a new %s client refuses sole unsupported Jcode without widening the query',
  async (transport) => {
    const call = vi.fn(async () => unavailableSessionSearchStatus())
    expect(
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'proof',
        filters: { agents: ['jcode'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  }
)
