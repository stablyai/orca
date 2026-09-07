import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateRequest
} from './worktree-create-payload'
import type { WorkspaceLinkedItem } from '../../../../../../shared/worktree/types'

const odooLink: WorkspaceLinkedItem = {
  provider: 'odoo',
  type: 'issue',
  number: 45514,
  title: '#45514 Ticket',
  url: 'https://odoo.example.test/odoo/project.task/45514',
  odooInstanceId: 'prod'
}

function request(linkedWorkItem: WorkspaceLinkedItem | null): WorktreeCreateRequest {
  return {
    repoId: 'repo-1',
    name: 'ticket-45514',
    options: { linkedWorkItem }
  } as WorktreeCreateRequest
}

const attempt = { name: 'ticket-45514' }

/**
 * The stage sync and the sidebar badge read the flat ticket fields. A workspace
 * started from a ticket used to persist only `linkedWorkItem`, so the board move
 * reported success while the Odoo stage never changed.
 */
describe('Odoo link fields in the create payload', () => {
  it('derives the flat ticket fields from an Odoo work item', () => {
    const local = buildLocalWorktreeCreateArgs(request(odooLink), attempt)
    expect(local.linkedOdooTicket).toBe(45514)
    expect(local.linkedOdooInstanceId).toBe('prod')
  })

  it('carries them on the runtime transport too, so both spell the link alike', () => {
    const runtime = buildRuntimeWorktreeCreateParams(request(odooLink), attempt)
    expect(runtime.linkedOdooTicket).toBe(45514)
    expect(runtime.linkedOdooInstanceId).toBe('prod')
  })

  it('leaves the instance null when the link carries none', () => {
    const local = buildLocalWorktreeCreateArgs(
      request({ ...odooLink, odooInstanceId: undefined }),
      attempt
    )
    expect(local.linkedOdooTicket).toBe(45514)
    expect(local.linkedOdooInstanceId).toBeNull()
  })

  it('adds nothing for another provider', () => {
    const local = buildLocalWorktreeCreateArgs(
      request({ provider: 'linear', type: 'issue', number: 7, title: 'ENG-7', url: 'https://x' }),
      attempt
    )
    expect(local.linkedOdooTicket).toBeUndefined()
    expect(local.linkedOdooInstanceId).toBeUndefined()
  })

  it('adds nothing when there is no linked work item', () => {
    const local = buildLocalWorktreeCreateArgs(request(null), attempt)
    expect(local.linkedOdooTicket).toBeUndefined()
  })
})
