import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreeCreateParams } from './worktree-create-payload'

const request = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  creationId: 'creation-1'
} as const

describe('the creation id sent to a paired server', () => {
  it('rides the request', () => {
    expect(buildRuntimeWorktreeCreateParams(request, { name: request.name })).toMatchObject({
      creationId: 'creation-1'
    })
  })
})
