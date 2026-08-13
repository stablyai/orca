import { describe, expect, it } from 'vitest'
import {
  formatGitHostWebSchemesText,
  parseGitHostWebSchemesText
} from './git-host-web-schemes-text'

describe('git-host-web-schemes-text', () => {
  it('round-trips host=scheme lines', () => {
    const text = formatGitHostWebSchemesText({
      'git.internal': 'http',
      'gitlab.company.test': 'http'
    })
    expect(text).toBe('git.internal=http\ngitlab.company.test=http')
    expect(parseGitHostWebSchemesText(text)).toEqual({
      'git.internal': 'http',
      'gitlab.company.test': 'http'
    })
  })

  it('skips blank, comment, and invalid rows', () => {
    expect(
      parseGitHostWebSchemesText(`
# comment
gitlab.company.test=http
broken
=http
host=ftp
`)
    ).toEqual({ 'gitlab.company.test': 'http' })
  })
})
