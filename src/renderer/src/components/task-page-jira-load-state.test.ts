import { describe, expect, it } from 'vitest'
import { createTaskPageJiraLoadFailureState } from './task-page-jira-load-state'

describe('TaskPage Jira load state', () => {
  it('explains Jira forbidden errors while clearing stale issues', () => {
    expect(createTaskPageJiraLoadFailureState(new Error('Forbidden'))).toEqual({
      issues: [],
      error: {
        title:
          'Error 403: Jira denied access to this issue search. Check project permissions or try a different JQL query.',
        details: 'Forbidden'
      }
    })
  })

  it('keeps raw provider detail separate from the Jira status summary', () => {
    expect(createTaskPageJiraLoadFailureState(new Error('Error 403: XSRF check failed'))).toEqual({
      issues: [],
      error: {
        title:
          'Error 403: Jira denied access to this issue search. Check project permissions or try a different JQL query.',
        details: 'XSRF check failed'
      }
    })
  })

  it('explains malformed JQL errors', () => {
    expect(createTaskPageJiraLoadFailureState(new Error('Malformed JQL'))).toEqual({
      issues: [],
      error: {
        title: "Jira couldn't run this JQL query. Check the syntax and try again.",
        details: 'Malformed JQL'
      }
    })
  })

  it('explains network errors', () => {
    expect(createTaskPageJiraLoadFailureState(new Error('Network request failed'))).toEqual({
      issues: [],
      error: {
        title: "Couldn't reach Jira. Check your connection and try again.",
        details: 'Network request failed'
      }
    })
  })

  it('explains Jira server errors', () => {
    expect(createTaskPageJiraLoadFailureState(new Error('Service Unavailable'))).toEqual({
      issues: [],
      error: {
        title: 'Error 503: Jira had a server error while loading issues. Try again in a moment.',
        details: 'Service Unavailable'
      }
    })
  })

  it('uses the generic load error for non-Error rejections', () => {
    expect(createTaskPageJiraLoadFailureState('failed')).toEqual({
      issues: [],
      error: {
        title: "Couldn't load Jira issues. Try again in a moment.",
        details: 'Failed to load Jira issues.'
      }
    })
  })
})
