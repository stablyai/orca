import { describe, expect, it } from 'vitest'
import { buildWorkspaceUrlUpdate, isWorkspaceUrlInputValid } from './WorktreeWorkspaceUrlField'

describe('workspace link field', () => {
  it('writes nothing when the link is unchanged', () => {
    expect(buildWorkspaceUrlUpdate(' https://app.test ', 'https://app.test')).toEqual({})
  })

  it('writes a new link and clears with an empty field', () => {
    expect(buildWorkspaceUrlUpdate('https://app.test/admin', '')).toEqual({
      workspaceUrl: 'https://app.test/admin'
    })
    expect(buildWorkspaceUrlUpdate('  ', 'https://app.test')).toEqual({ workspaceUrl: '' })
  })

  it('accepts empty or http(s) links only', () => {
    expect(isWorkspaceUrlInputValid('')).toBe(true)
    expect(isWorkspaceUrlInputValid('http://app.test')).toBe(true)
    expect(isWorkspaceUrlInputValid('app.test')).toBe(false)
    expect(isWorkspaceUrlInputValid('ftp://app.test')).toBe(false)
  })
})
