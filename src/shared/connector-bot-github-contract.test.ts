import { describe, expect, it } from 'vitest'
import { GITHUB_ID_PATTERN, GITHUB_LOGIN_PATTERN } from './connector-bot-github-contract'

describe('GitHub id and login patterns', () => {
  it('match the cloud’s: numeric ids without a leading zero', () => {
    expect(['1', '583231', '9'.repeat(20)].every((id) => GITHUB_ID_PATTERN.test(id))).toBe(true)
    expect(['0', '012', '9'.repeat(21), 'abc', ''].some((id) => GITHUB_ID_PATTERN.test(id))).toBe(
      false
    )
  })

  it('match the cloud’s: logins up to 39 characters, Enterprise Managed Users included', () => {
    const ok = ['octocat', 'mona-cat_octo', 'a', 'a'.repeat(39)]
    expect(ok.every((login) => GITHUB_LOGIN_PATTERN.test(login))).toBe(true)
    const bad = ['-octocat', '_octocat', 'a'.repeat(40), 'octo cat', '']
    expect(bad.some((login) => GITHUB_LOGIN_PATTERN.test(login))).toBe(false)
  })
})
