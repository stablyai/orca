import { describe, expect, it } from 'vitest'
import { TASK_PROVIDERS } from './task-providers'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import { WorkspaceLinkedItemSchema } from './workspace-linked-item-schema'

const odooItem = {
  provider: 'odoo',
  type: 'issue',
  number: 80,
  title: 'TASK-80 Guard empty password',
  url: 'https://odoo.example.com/odoo/project/7/task/80',
  odooInstanceId: 'instance-a'
}

describe('normalizeWorkspaceLinkedItem', () => {
  it('accepts every task provider, so the check cannot drift from TASK_PROVIDERS', () => {
    for (const provider of TASK_PROVIDERS) {
      expect(
        normalizeWorkspaceLinkedItem({ ...odooItem, provider })?.provider,
        `provider ${provider} rejected`
      ).toBe(provider)
    }
    expect(normalizeWorkspaceLinkedItem({ ...odooItem, provider: 'bitbucket' })).toBeNull()
  })

  it('keeps odooInstanceId, which is what makes an Odoo ticket number addressable', () => {
    expect(normalizeWorkspaceLinkedItem(odooItem)).toEqual({
      provider: 'odoo',
      type: 'issue',
      number: 80,
      title: 'TASK-80 Guard empty password',
      url: 'https://odoo.example.com/odoo/project/7/task/80',
      odooInstanceId: 'instance-a'
    })
    expect(
      normalizeWorkspaceLinkedItem({ ...odooItem, odooInstanceId: '  instance-a  ' })
        ?.odooInstanceId
    ).toBe('instance-a')
    expect(normalizeWorkspaceLinkedItem({ ...odooItem, odooInstanceId: '   ' })).not.toHaveProperty(
      'odooInstanceId'
    )
  })

  it('lets an Odoo item through the schema that worktrees:create parses', () => {
    const parsed = WorkspaceLinkedItemSchema.safeParse(odooItem)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    expect(parsed.success && parsed.data.odooInstanceId).toBe('instance-a')
    // A rejected item must still surface the product's error, or the check above proves nothing.
    const rejected = WorkspaceLinkedItemSchema.safeParse({ ...odooItem, provider: 'bitbucket' })
    expect(rejected.success).toBe(false)
    expect(rejected.success ? '' : rejected.error.issues[0]?.message).toBe(
      'Invalid linked work item'
    )
  })
})
