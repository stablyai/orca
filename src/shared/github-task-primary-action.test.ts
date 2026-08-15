import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GITHUB_TASK_PRIMARY_ACTION,
  isGitHubTaskPrimaryAction,
  normalizeGitHubTaskPrimaryAction,
  resolveGitHubTaskSplitActions
} from './github-task-primary-action'

describe('normalizeGitHubTaskPrimaryAction', () => {
  it('defaults new users and unknown values to Start', () => {
    expect(normalizeGitHubTaskPrimaryAction(undefined)).toBe(DEFAULT_GITHUB_TASK_PRIMARY_ACTION)
    expect(normalizeGitHubTaskPrimaryAction(null)).toBe('start')
    expect(normalizeGitHubTaskPrimaryAction('resume')).toBe('start')
    expect(normalizeGitHubTaskPrimaryAction('')).toBe('start')
  })

  it('keeps an explicit Open-in-browser choice', () => {
    expect(normalizeGitHubTaskPrimaryAction('open-in-browser')).toBe('open-in-browser')
  })

  it('keeps an explicit Start choice', () => {
    expect(normalizeGitHubTaskPrimaryAction('start')).toBe('start')
  })
})

describe('isGitHubTaskPrimaryAction', () => {
  it('accepts only the persisted Start vs Open-in-browser pair', () => {
    expect(isGitHubTaskPrimaryAction('start')).toBe(true)
    expect(isGitHubTaskPrimaryAction('open-in-browser')).toBe(true)
    expect(isGitHubTaskPrimaryAction('resume')).toBe(false)
  })
})

describe('resolveGitHubTaskSplitActions', () => {
  it('presents Start as the primary action for new users', () => {
    expect(resolveGitHubTaskSplitActions(undefined)).toEqual({
      primary: 'start',
      menu: ['open-in-browser']
    })
  })

  it('promotes Open in browser after that choice is remembered', () => {
    expect(resolveGitHubTaskSplitActions('open-in-browser')).toEqual({
      primary: 'open-in-browser',
      menu: ['start']
    })
  })

  it('keeps Start available after remembering Open in browser', () => {
    const resolved = resolveGitHubTaskSplitActions('open-in-browser')
    expect(resolved.menu).toContain('start')
    expect(resolved.primary).not.toBe('start')
  })
})
