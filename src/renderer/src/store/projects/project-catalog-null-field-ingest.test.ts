import { expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

import './project-host-routing'
import '../host-catalog/endpoint-catalog-adoption'

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

import { createTestStore } from '../testing/app-store-test-fixture'
import * as launchDrafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as launchDraftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as launchDraftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as launchDraftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'

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
    const key = launchDraftsOwner1.nativeChatLaunchPromptDraftScopeKey(
      'repo-1::/source-only',
      'codex',
      'local'
    )
    const other = launchDraftsOwner1.nativeChatLaunchPromptDraftScopeKey(
      'repo-1::/source-only',
      'codex',
      'ssh:other'
    )
    for (const scope of [key, other]) {
      launchDraftsOwner2.updateNativeChatComposerDraft(scope, { text: 'task' }, 'immediate')
    }
    const attempt = launchDraftsOwner3.captureNativeChatComposerSubmission(key)
    expect(
      await store.getState().deleteProjectHostSetup({ setupId: setup.id, hostId: 'local' })
    ).toBeNull()
    expect(attempt.draft?.text).toBe('task')
    expect(
      await store.getState().deleteProjectHostSetup({ setupId: setup.id, hostId: 'local' })
    ).not.toBeNull()
    expect(attempt.draft === undefined).toBe(registered)
    expect(launchDraftsOwner2.readNativeChatComposerDraft(key).text).toBe('task')
    expect(launchDraftsOwner2.readNativeChatComposerDraft(other).text).toBe('task')
    launchDrafts.clearNativeChatComposerDraftsForTests()
    vi.unstubAllGlobals()
  }
)
