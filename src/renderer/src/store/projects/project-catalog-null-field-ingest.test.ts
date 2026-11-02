import { describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

import { fetchProjectHostSetupCompatibility } from './project-host-routing'
import { adoptFromEndpoint } from '../adopt-from-endpoint'

// Normalize wire catalog fields at ingest so null repoId/path cannot crash Settings/sidebar trim/grouping readers (3bcc5be3, v1.4.188 Linux).
const repos = [
  { id: 'repo-1', path: '/Users/alice/orca', displayName: 'orca', badgeColor: '#000', addedAt: 1 }
] satisfies Repo[]

const projects = [
  {
    id: 'repo:repo-1',
    displayName: 'orca',
    badgeColor: '#000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  }
] satisfies Project[]

// Reflect.set models older-host malformed fields without asserting them valid.
function badSetups(): ProjectHostSetup[] {
  const base = (id: string, displayName: string): ProjectHostSetup => ({
    id,
    projectId: 'repo:repo-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/Users/alice/orca',
    displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  })
  const corrupted = base('repo:repo-1::local::2', 'orca-2')
  Reflect.set(corrupted, 'repoId', null)
  Reflect.set(corrupted, 'path', null)
  return [base('repo:repo-1::local', 'orca'), corrupted]
}

function stubProjectsApi(setups: ProjectHostSetup[], projectRows: Project[] = projects): void {
  vi.stubGlobal('window', {
    api: {
      projects: {
        list: vi.fn().mockResolvedValue(projectRows),
        listHostSetups: vi.fn().mockResolvedValue(setups)
      }
    }
  })
}

describe('project catalog ingest with non-string row fields', () => {
  it('coerces a null repoId and path on the local IPC boundary', async () => {
    stubProjectsApi(badSetups())
    const projection = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const row = projection.setups.find((setup) => setup.id === 'repo:repo-1::local::2')
    expect(row?.repoId).toBe('')
    expect(row?.path).toBe('')
  })

  // Mixed-version remote decoders pass rows verbatim; ingest cannot assume hosts normalized them.
  it('coerces on the remote adoption boundary too', () => {
    const adopted = adoptFromEndpoint(
      { kind: 'environment', environmentId: 'env-1' },
      { kind: 'projectHostSetup', row: badSetups()[1]! }
    )
    expect(adopted.repoId).toBe('')
    expect(adopted.path).toBe('')
    expect(adopted.hostId).toBe('runtime:env-1')
  })

  // Why: a coerced field must change one value, never which rows exist.
  it('does not add or drop rows because a field was repaired', async () => {
    stubProjectsApi(badSetups())
    const repaired = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const clean = badSetups()
    ;(clean[1] as { repoId: string; path: string }).repoId = ''
    ;(clean[1] as { repoId: string; path: string }).path = ''
    stubProjectsApi(clean)
    const untouched = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    expect(repaired.setups.map((setup) => setup.id)).toEqual(
      untouched.setups.map((setup) => setup.id)
    )
    expect(repaired.projects.map((project) => project.id)).toEqual(
      untouched.projects.map((project) => project.id)
    )
  })
})

import { createTestStore } from '../slices/store-test-helpers'
import * as launchDrafts from '@/components/native-chat/native-chat-composer-draft-store'

it.each([false, true])(
  'actual host-setup deletion revokes new return writers only for a returned registered repo=%s',
  async (registered) => {
    launchDrafts.clearNativeChatComposerDraftsForTests()
    const setup = badSetups()[0]
    const store = createTestStore()
    store.setState({ repos, projects, projectHostSetups: [setup] })
    const deleteSetup = vi
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValue({ project: projects[0], setup, ...(registered ? { repo: repos[0] } : {}) })
    vi.stubGlobal('window', { api: { projects: { deleteHostSetup: deleteSetup } } })
    const key = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
      'repo-1::/source-only',
      'codex',
      'local'
    )
    const other = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
      'repo-1::/source-only',
      'codex',
      'ssh:other'
    )
    for (const scope of [key, other]) {
      launchDrafts.updateNativeChatComposerDraft(scope, { text: 'task' }, 'immediate')
    }
    const attempt = launchDrafts.captureNativeChatComposerSubmission(key)
    expect(
      await store.getState().deleteProjectHostSetup({ setupId: setup.id, hostId: 'local' })
    ).toBeNull()
    expect(attempt.draft?.text).toBe('task')
    expect(
      await store.getState().deleteProjectHostSetup({ setupId: setup.id, hostId: 'local' })
    ).not.toBeNull()
    expect(attempt.draft === undefined).toBe(registered)
    expect(launchDrafts.readNativeChatComposerDraft(key).text).toBe('task')
    expect(launchDrafts.readNativeChatComposerDraft(other).text).toBe('task')
    launchDrafts.clearNativeChatComposerDraftsForTests()
    vi.unstubAllGlobals()
  }
)
