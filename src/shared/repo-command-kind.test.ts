import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPO_COMMAND_TEMPLATE,
  REPO_COMMAND_YAML_KEY,
  getRepoCommandKindForLinkedItemType,
  isRepoCommandKind
} from './repo-command-kind'

describe('repo-command-kind', () => {
  it('maps each kind to its yaml key and default template', () => {
    expect(REPO_COMMAND_YAML_KEY).toEqual({ issue: 'issueCommand', review: 'reviewCommand' })
    expect(DEFAULT_REPO_COMMAND_TEMPLATE).toEqual({
      issue: 'Complete {{artifact_url}}',
      review: 'Review {{artifact_url}}'
    })
  })

  it('derives the kind from a linked work item type', () => {
    expect(getRepoCommandKindForLinkedItemType('issue')).toBe('issue')
    expect(getRepoCommandKindForLinkedItemType('pr')).toBe('review')
    expect(getRepoCommandKindForLinkedItemType('mr')).toBe('review')
    expect(getRepoCommandKindForLinkedItemType(undefined)).toBe('issue')
    expect(getRepoCommandKindForLinkedItemType(null)).toBe('issue')
  })

  it('guards unknown kinds arriving over IPC', () => {
    expect(isRepoCommandKind('review')).toBe(true)
    expect(isRepoCommandKind('pullRequest')).toBe(false)
    expect(isRepoCommandKind(undefined)).toBe(false)
  })
})
