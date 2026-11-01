import { describe, expect, it } from 'vitest'
import { resolveHubProjectId } from './project-hub-project-id'
describe('Project Hub native identity',()=>{
  const projects=[
    {id:'project-local',sourceRepoIds:['repo-1']},
    {id:'project-remote',sourceRepoIds:['repo-1']}
  ]
  // Preserve the literal ExecutionHostId domain: 'local' | `ssh:${string}` | `runtime:${string}`.
  const setups=[
    {projectId:'project-local',repoId:'repo-1',hostId:'local'},
    {projectId:'project-remote',repoId:'repo-1',hostId:'ssh:test'}
  ] as const
  it('trusts a known native Project.id over guessed names',()=>{
    expect(resolveHubProjectId({projectId:'project-remote',repoId:'repo-1',hostId:'local',projects,setups})).toBe('project-remote')
  })
  it('separates same-repo setups on different hosts',()=>{
    expect(resolveHubProjectId({repoId:'repo-1',hostId:'local',projects,setups})).toBe('project-local')
    expect(resolveHubProjectId({repoId:'repo-1',hostId:'ssh:test',projects,setups})).toBe('project-remote')
  })
  it('refuses an ambiguous host instead of choosing the first project',()=>{
    expect(resolveHubProjectId({repoId:'repo-1',projects,setups})).toBeNull()
  })
  it('supports a canonical repo fallback for an older catalog',()=>{
    expect(resolveHubProjectId({repoId:'repo-legacy',projects:[],setups:[],fallback:'repo:old'})).toBe('repo:old')
  })
})
