import { beforeEach, expect, it, vi } from 'vitest'
import { hostModelMenuCatalog, ModelMenuContextUnresolvedError } from './host-model-menu-catalog'
import { resetHostModelCatalogSnapshotsForTests } from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'

const target = { kind: 'local' } as const
const answer = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 0,
  modelsDifferByWorkspace: true,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
})

it('does not suppress a prompt retry after an unresolved WSL context', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new ModelMenuContextUnresolvedError())
    .mockResolvedValueOnce(answer('ubuntu-model'))
  const scope = { target, agent: 'antigravity', sourceKey: 'cli-unresolved', request }
  const owner = hostModelMenuCatalog(scope)
  const stop = owner.subscribe(() => {})
  await owner.read(true, undefined, new AbortController().signal)
  expect(await owner.read(true, undefined, new AbortController().signal)).toEqual(
    answer('ubuntu-model')
  )
  expect(request).toHaveBeenCalledTimes(2)
  stop()
})
