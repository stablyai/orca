import { describe, expect, it } from 'vitest'
import type { CommitMessageDraftContext } from './commit-message-generation'
import {
  formatLinkedIssueTemplateValue,
  withLinkedIssueDraftContext
} from './source-control-ai-action-variables'
import { renderSourceControlActionCommandTemplate } from './source-control-ai-actions'

describe('formatLinkedIssueTemplateValue', () => {
  it('renders anything that is not a positive integer as an empty string', () => {
    // Corrupt issue numbers must not produce references like Fixes #-7 or Fixes #1e+21.
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
