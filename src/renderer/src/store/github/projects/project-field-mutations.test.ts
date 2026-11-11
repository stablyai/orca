import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import { projectViewCacheKey } from '../cache/cache-identity'
import type { GitHubProjectTable } from '../../../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../../../shared/github/project-result-types'

const key = projectViewCacheKey('user', 'owner', 1, 'view')
const failed: GitHubProjectMutationResult = {
  ok: false,
  error: { type: 'network_error', message: 'Offline' }
}

function fixture(): GitHubProjectTable {
  return {
    project: {
      id: 'project',
      owner: 'owner',
      ownerType: 'user',
      number: 1,
      title: 'Test',
      url: ''
    },
    selectedView: {
      id: 'view',
      number: 1,
      name: 'Board',
      layout: 'BOARD_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: [],
      verticalGroupByFields: [
        {
          id: 'status',
          name: 'Status',
          kind: 'single-select',
          dataType: 'SINGLE_SELECT',
          options: [
            { id: 'todo', name: 'Todo', color: 'GREEN' },
            { id: 'done', name: 'Done', color: 'PURPLE' }
          ]
        }
      ]
    },
    rows: [
      {
        id: 'row',
        itemType: 'ISSUE',
        updatedAt: '',
        position: 0,
        content: {
          title: 'Original',
          number: 1,
          body: null,
          url: '',
          state: 'OPEN',
          stateReason: null,
          isDraft: null,
          repository: 'owner/repo',
          assignees: [],
          labels: [],
          parentIssue: null,
          issueType: null
        },
        fieldValuesByFieldId: {
          status: {
            kind: 'single-select',
            fieldId: 'status',
            optionId: 'todo',
            name: 'Todo',
            color: 'GREEN'
          }
        }
      }
    ],
    totalCount: 1,
    parentFieldDropped: false
  }
}

function setup() {
  const store = createTestStore()
  store.setState({ projectViewCache: { [key]: { data: fixture(), fetchedAt: 1 } } })
  return store
}

function deferred() {
  let resolve: (result: GitHubProjectMutationResult) => void = () => {
    throw new Error('Not initialized')
  }
  const promise = new Promise<GitHubProjectMutationResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const field = (store: ReturnType<typeof setup>) =>
  store.getState().projectViewCache[key]?.data?.rows[0]?.fieldValuesByFieldId.status

beforeEach(() => {
  vi.resetAllMocks()
  resetRemoteRuntimeMocks()
})

describe('project field writes', () => {
  it.each([true, false])(
    'rolls a failed clear back to the last confirmed value (first succeeds: %s)',
    async (succeeds) => {
      const store = setup()
      const first = deferred()
      mockApi.gh.updateProjectItemField.mockReturnValueOnce(first.promise)
      mockApi.gh.clearProjectItemField.mockResolvedValueOnce(failed)
      const update = store
        .getState()
        .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
      const clear = store.getState().clearProjectFieldValue(key, 'row', 'status')
      first.resolve(succeeds ? { ok: true } : failed)
      await Promise.all([update, clear])
      expect(field(store)).toMatchObject({ optionId: succeeds ? 'done' : 'todo' })
    }
  )

  it('keeps the confirmed baseline when failed writes switch between cached views', async () => {
    const store = setup()
    const otherKey = projectViewCacheKey('user', 'owner', 1, 'other-view')
    const other = fixture()
    other.selectedView.id = 'other-view'
    store.setState({
      projectViewCache: {
        ...store.getState().projectViewCache,
        [otherKey]: { data: other, fetchedAt: 1 }
      }
    })
    const first = deferred()
    mockApi.gh.updateProjectItemField
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(failed)
    mockApi.gh.clearProjectItemField.mockResolvedValueOnce(failed)
    const update1 = store
      .getState()
      .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
    const update2 = store.getState().updateProjectFieldValue(otherKey, 'row', 'status', {
      kind: 'single-select',
      optionId: 'done'
    })
    const clear = store.getState().clearProjectFieldValue(key, 'row', 'status')
    first.resolve(failed)
    await Promise.all([update1, update2, clear])
    expect(field(store)).toMatchObject({ optionId: 'todo' })
    expect(
      store.getState().projectViewCache[otherKey]?.data?.rows[0]?.fieldValuesByFieldId.status
    ).toMatchObject({ optionId: 'todo' })
  })

  it('does not roll back a newer clear when two clear requests overlap', async () => {
    const store = setup()
    const first = deferred()
    const second = deferred()
    mockApi.gh.clearProjectItemField
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const clear1 = store.getState().clearProjectFieldValue(key, 'row', 'status')
    const clear2 = store.getState().clearProjectFieldValue(key, 'row', 'status')
    first.resolve(failed)
    await clear1
    expect(field(store)).toBeUndefined()
    second.resolve({ ok: true })
    await clear2
    expect(field(store)).toBeUndefined()
  })

  it('uses a refreshed value as the rollback baseline for a subsequently queued edit', async () => {
    const store = setup()
    const first = deferred()
    mockApi.gh.updateProjectItemField.mockReturnValueOnce(first.promise)
    mockApi.gh.clearProjectItemField.mockResolvedValueOnce(failed)
    const update = store
      .getState()
      .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
    const refreshed = fixture()
    refreshed.rows[0].fieldValuesByFieldId.status = {
      kind: 'single-select',
      fieldId: 'status',
      optionId: 'doing',
      name: 'Doing',
      color: 'YELLOW'
    }
    store.setState({ projectViewCache: { [key]: { data: refreshed, fetchedAt: 2 } } })
    const clear = store.getState().clearProjectFieldValue(key, 'row', 'status')
    first.resolve(failed)
    await Promise.all([update, clear])
    expect(field(store)).toMatchObject({ optionId: 'doing' })
  })
})
