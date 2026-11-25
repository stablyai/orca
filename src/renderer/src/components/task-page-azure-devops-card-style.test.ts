import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBoardStyleClause,
  AzureDevOpsBoardStyleRule,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import { resolveAzureDevOpsCardStyle } from './task-page-azure-devops-card-style'

function item(fields: Record<string, unknown> = {}): AzureDevOpsWorkItem {
  const merged = { 'System.State': 'Active', 'System.Title': 'Fix login', ...fields }
  return {
    id: 1,
    rev: 1,
    workItemType: 'User Story',
    title: 'Fix login',
    state: 'Active',
    assignedTo: null,
    areaPath: 'Project',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: null,
    url: 'https://dev.azure.com/acme/Project/_apis/wit/workItems/1',
    fields: merged
  }
}

function clause(
  fieldName: string,
  operator: string,
  value: string,
  logicalOperator: 'and' | 'or' | null = null
): AzureDevOpsBoardStyleClause {
  return { fieldName, operator, value, logicalOperator }
}

function ruleOf(
  clauses: AzureDevOpsBoardStyleClause[],
  backgroundColor = '#FBBC3D',
  titleColor: string | null = '#000000'
): AzureDevOpsBoardStyleRule {
  return { name: 'rule', clauses, backgroundColor, titleColor }
}

function rule(fieldName: string, operator: string, value: string): AzureDevOpsBoardStyleRule {
  return ruleOf([clause(fieldName, operator, value)])
}

const ACTIVE = { backgroundColor: '#FBBC3D', titleColor: '#000000' }

describe('resolveAzureDevOpsCardStyle', () => {
  it('matches an equality clause and returns the rule’s colours', () => {
    expect(
      resolveAzureDevOpsCardStyle(item({ 'System.State': 'Active' }), [
        rule('System.State', '=', 'Active')
      ])
    ).toEqual(ACTIVE)
  })

  it('compares strings case-insensitively', () => {
    expect(resolveAzureDevOpsCardStyle(item(), [rule('System.State', '=', 'ACTIVE')])).toEqual(
      ACTIVE
    )
    expect(resolveAzureDevOpsCardStyle(item(), [rule('System.State', '<>', 'active')])).toBeNull()
  })

  it('compares numbers numerically, not as strings', () => {
    const it2 = item({ 'Microsoft.VSTS.Common.Priority': 2 })
    expect(
      resolveAzureDevOpsCardStyle(it2, [rule('Microsoft.VSTS.Common.Priority', '<', '10')])
    ).toEqual(ACTIVE)
    expect(
      resolveAzureDevOpsCardStyle(it2, [rule('Microsoft.VSTS.Common.Priority', '>=', '10')])
    ).toBeNull()
  })

  it('matches a whole tag for contains on System.Tags', () => {
    const tagged = item({ 'System.Tags': 'blocked; needs-info' })
    expect(
      resolveAzureDevOpsCardStyle(tagged, [rule('System.Tags', 'contains', 'blocked')])
    ).toEqual(ACTIVE)
    const unblocked = item({ 'System.Tags': 'unblocked' })
    expect(
      resolveAzureDevOpsCardStyle(unblocked, [rule('System.Tags', 'contains', 'blocked')])
    ).toBeNull()
    expect(
      resolveAzureDevOpsCardStyle(unblocked, [rule('System.Tags', 'does not contain', 'blocked')])
    ).toEqual(ACTIVE)
  })

  it('matches a substring for contains on a text field', () => {
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.Title', 'contains', 'LOGIN')])
    ).toEqual(ACTIVE)
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.Title', 'does not contain', 'login')])
    ).toBeNull()
  })

  it('supports in and not in with a comma list', () => {
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.State', 'in', 'New, active ,Closed')])
    ).toEqual(ACTIVE)
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.State', 'not in', 'New,Closed')])
    ).toEqual(ACTIVE)
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.State', 'not in', 'Active')])
    ).toBeNull()
  })

  it('joins clauses with and', () => {
    const r = (v: string) =>
      ruleOf([clause('System.State', '=', 'Active'), clause('System.Title', 'contains', v, 'and')])
    expect(resolveAzureDevOpsCardStyle(item(), [r('login')])).toEqual(ACTIVE)
    expect(resolveAzureDevOpsCardStyle(item(), [r('nope')])).toBeNull()
  })

  it('joins clauses with or', () => {
    const r = ruleOf([
      clause('System.State', '=', 'New'),
      clause('System.Title', 'contains', 'login', 'or')
    ])
    expect(resolveAzureDevOpsCardStyle(item(), [r])).toEqual(ACTIVE)
  })

  it('evaluates mixed and/or left to right without precedence', () => {
    // true or false and false: left to right is false, whereas and-precedence would give true.
    const r = ruleOf([
      clause('System.State', '=', 'Active'),
      clause('System.State', '=', 'New', 'or'),
      clause('System.Title', 'contains', 'nope', 'and')
    ])
    expect(resolveAzureDevOpsCardStyle(item(), [r])).toBeNull()
  })

  it('skips a rule whose clause names an unknown operator', () => {
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.State', 'was ever', 'Active')])
    ).toBeNull()
  })

  it('skips a rule whose clause names a field the item does not carry', () => {
    const r = ruleOf([clause('System.State', '=', 'Active'), clause('Custom.Gone', '=', 'x', 'or')])
    expect(resolveAzureDevOpsCardStyle(item(), [r])).toBeNull()
  })

  it('skips a rule whose value is a macro', () => {
    const r = ruleOf([
      clause('System.State', '=', 'Active'),
      clause('System.AssignedTo', '=', '@Me', 'or')
    ])
    expect(
      resolveAzureDevOpsCardStyle(item({ 'System.AssignedTo': 'Ada Lovelace' }), [r])
    ).toBeNull()
  })

  it('returns the first matching rule when several match', () => {
    const second = ruleOf([clause('System.State', '=', 'Active')], '#111111', null)
    expect(
      resolveAzureDevOpsCardStyle(item(), [
        rule('System.State', '=', 'New'),
        rule('System.State', '=', 'Active'),
        second
      ])
    ).toEqual(ACTIVE)
  })

  it('returns null when no rule matches', () => {
    expect(resolveAzureDevOpsCardStyle(item(), [rule('System.State', '=', 'New')])).toBeNull()
    expect(resolveAzureDevOpsCardStyle(item(), [])).toBeNull()
  })

  it('skips a rule when the field value has no text form', () => {
    const cases: [unknown, string][] = [
      [{ id: 3 }, '<>'],
      [['a', 'b'], 'does not contain'],
      [null, 'not in']
    ]
    for (const [value, operator] of cases) {
      expect(
        resolveAzureDevOpsCardStyle(item({ 'Custom.X': value }), [
          rule('Custom.X', operator, 'Done')
        ])
      ).toBeNull()
    }
  })

  it('does not read prototype keys as fields', () => {
    expect(resolveAzureDevOpsCardStyle(item(), [rule('constructor', '<>', 'x')])).toBeNull()
  })

  it('skips a rule when any in-list entry is a macro', () => {
    expect(
      resolveAzureDevOpsCardStyle(item(), [rule('System.State', 'in', 'Active, @me')])
    ).toBeNull()
  })

  it('matches an identity on displayName or uniqueName for positive operators', () => {
    const ada = item({
      'System.AssignedTo': { displayName: 'Ada Lovelace', uniqueName: 'ada@contoso.com' }
    })
    expect(
      resolveAzureDevOpsCardStyle(ada, [rule('System.AssignedTo', '=', 'ada@contoso.com')])
    ).toEqual(ACTIVE)
    expect(
      resolveAzureDevOpsCardStyle(ada, [rule('System.AssignedTo', 'in', 'Ada Lovelace')])
    ).toEqual(ACTIVE)
  })

  it('requires both identity names to fail for negative operators', () => {
    const ada = item({
      'System.AssignedTo': { displayName: 'Ada Lovelace', uniqueName: 'ada@contoso.com' }
    })
    expect(
      resolveAzureDevOpsCardStyle(ada, [rule('System.AssignedTo', '<>', 'ada@contoso.com')])
    ).toBeNull()
    expect(
      resolveAzureDevOpsCardStyle(ada, [rule('System.AssignedTo', '<>', 'Grace Hopper')])
    ).toEqual(ACTIVE)
  })
})
