import { expect, it } from 'vitest'
import {
  folderGroupDefaultTarget,
  projectWorkspaceDefault
} from './quick-workspace-project-default'

it('selects the target project choice, including blank, before the global choice', () => {
  const projects = [
    { id: 'source', defaultTuiAgent: 'claude' as const },
    { id: 'target', defaultTuiAgent: 'codex' as const },
    { id: 'blank', defaultTuiAgent: 'blank' as const },
    { id: 'inherit', defaultTuiAgent: null }
  ]
  expect(projectWorkspaceDefault(projects, 'target', 'claude')).toBe('codex')
  expect(projectWorkspaceDefault(projects, 'blank', 'claude')).toBe('blank')
  expect(projectWorkspaceDefault(projects, 'inherit', 'claude')).toBe('claude')
  expect(projectWorkspaceDefault(projects, null, 'claude')).toBe('claude')
})

it('uses one project across folder source repos and rejects mixed project owners', () => {
  const projects = [
    { id: 'A', sourceRepoIds: ['repo-a'] },
    { id: 'B', sourceRepoIds: ['repo-b', 'repo-b2'] }
  ]
  expect(folderGroupDefaultTarget(['repo-b', 'repo-b2'], projects, [], 'local')).toEqual({
    repoId: 'repo-b',
    projectId: 'B'
  })
  expect(folderGroupDefaultTarget(['repo-a', 'repo-b'], projects, [], 'local')).toBeNull()
  expect(folderGroupDefaultTarget([], projects, [], 'local')).toBeNull()
})

it('honors host-qualified project setup ownership for a folder group', () => {
  const projects = [
    { id: 'A', sourceRepoIds: ['same'] },
    { id: 'B', sourceRepoIds: ['same'] }
  ]
  const setups = [{ repoId: 'same', projectId: 'B', hostId: 'ssh:b' as const }]
  expect(folderGroupDefaultTarget(['same'], projects, setups, 'ssh:b')).toEqual({
    repoId: 'same',
    projectId: 'B'
  })
  expect(folderGroupDefaultTarget(['same'], projects, setups, 'local')).toBeNull()
})
