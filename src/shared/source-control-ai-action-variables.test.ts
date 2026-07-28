import { describe, expect, it } from 'vitest'
import type { CommitMessageDraftContext } from './commit-message-generation'
import {
  formatLinkedIssueTemplateValue,
  SOURCE_CONTROL_ACTION_VARIABLE_INFO,
  SOURCE_CONTROL_ACTION_VARIABLES,
  withLinkedIssueDraftContext
} from './source-control-ai-action-variables'
import {
  renderSourceControlActionCommandTemplate,
  SOURCE_CONTROL_LAUNCH_ACTION_IDS
} from './source-control-ai-actions'

describe('source-control AI variable registry', () => {
  it('documents every registered variable so chip hover cards cannot crash', () => {
    // Why: the registry type already makes an undocumented chip a compile error;
    // this keeps the guarantee falsifiable at runtime if that type ever loosens.
    const documented = new Set<string>(Object.keys(SOURCE_CONTROL_ACTION_VARIABLE_INFO))
    const undocumented = [...new Set(Object.values(SOURCE_CONTROL_ACTION_VARIABLES).flat())].filter(
      (variable) => !documented.has(variable)
    )

    expect(undocumented).toEqual([])
  })

  it('offers linkedIssue on commit message and pull request only', () => {
    expect(SOURCE_CONTROL_ACTION_VARIABLES.commitMessage).toContain('linkedIssue')
    expect(SOURCE_CONTROL_ACTION_VARIABLES.pullRequest).toContain('linkedIssue')
    expect(SOURCE_CONTROL_ACTION_VARIABLES.branchName).not.toContain('linkedIssue')
    for (const actionId of SOURCE_CONTROL_LAUNCH_ACTION_IDS) {
      expect(SOURCE_CONTROL_ACTION_VARIABLES[actionId]).not.toContain('linkedIssue')
    }
  })

  it('names GitHub and the empty case in the linkedIssue description', () => {
    const info = SOURCE_CONTROL_ACTION_VARIABLE_INFO.linkedIssue
    expect(info.description).toContain('GitHub')
    expect(info.description).toContain('Empty')
    expect(info.example).toBe('123')
  })
})

describe('formatLinkedIssueTemplateValue', () => {
  it('renders positive integers as decimal strings', () => {
    expect(formatLinkedIssueTemplateValue(123)).toBe('123')
    expect(formatLinkedIssueTemplateValue(1)).toBe('1')
  })

  it('renders anything that is not a positive integer as an empty string', () => {
    // Why: `Fixes #-7` / `Fixes #1e+21` are worse output than `Fixes #`, so corrupt
    // metadata degrades to the unlinked rendering instead of a nonsense reference.
    for (const value of [
      0,
      -7,
      12.9,
      1e21,
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY
    ]) {
      expect(formatLinkedIssueTemplateValue(value)).toBe('')
    }
  })

  it('expands both brace forms and never leaves the token literal', () => {
    const template = 'Fixes #{linkedIssue} / {{ linkedIssue }}'
    expect(
      renderSourceControlActionCommandTemplate(template, {
        linkedIssue: formatLinkedIssueTemplateValue(42)
      })
    ).toBe('Fixes #42 / 42')
    expect(
      renderSourceControlActionCommandTemplate(template, {
        linkedIssue: formatLinkedIssueTemplateValue(null)
      })
    ).toBe('Fixes # / ')
  })
})

describe('withLinkedIssueDraftContext', () => {
  it('attaches only positive integers and leaves the context untouched otherwise', () => {
    const context: CommitMessageDraftContext = {
      branch: 'main',
      stagedSummary: 'M a.ts',
      stagedPatch: 'diff'
    }

    expect(withLinkedIssueDraftContext(context, 42)).toEqual({ ...context, linkedIssue: 42 })
    for (const value of [null, undefined, Number.NaN, 0, -7, 12.9]) {
      expect(withLinkedIssueDraftContext(context, value)).toBe(context)
    }
  })
})
