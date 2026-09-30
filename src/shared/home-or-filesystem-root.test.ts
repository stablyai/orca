import { describe, expect, it } from 'vitest'
import { isTooBroadToPreTrust } from './home-or-filesystem-root'

describe('isTooBroadToPreTrust', () => {
  it.each([
    ['/'],
    ['C:\\'],
    ['c:/'],
    ['\\\\server\\share'],
    ['\\\\wsl.localhost\\Ubuntu\\'],
    ['//wsl$/Ubuntu']
  ])('treats %s as a filesystem root', (folderPath) => {
    expect(isTooBroadToPreTrust(folderPath, [])).toBe(true)
  })

  it('matches a home however its separators, trailing slash or drive case are spelled', () => {
    expect(isTooBroadToPreTrust('/home/u/', ['/home/u'])).toBe(true)
    expect(isTooBroadToPreTrust('c:\\users\\alice', [null, 'C:/Users/alice/'])).toBe(true)
    expect(
      isTooBroadToPreTrust('\\\\wsl.localhost\\Ubuntu\\home\\u', [
        undefined,
        '\\\\wsl$\\Ubuntu\\home\\u'
      ])
    ).toBe(true)
  })

  it('refuses a folder above a home, which would cover the home too', () => {
    expect(isTooBroadToPreTrust('/home', ['/home/u'])).toBe(true)
    expect(isTooBroadToPreTrust('/Users/', [null, '/Users/alice'])).toBe(true)
    expect(isTooBroadToPreTrust('C:\\Users', ['c:/users/alice'])).toBe(true)
  })

  it('leaves folders inside a home, and other folders, alone', () => {
    expect(isTooBroadToPreTrust('/home/u/repo', ['/home/u'])).toBe(false)
    expect(isTooBroadToPreTrust('/home/u2', ['/home/u'])).toBe(false)
    expect(isTooBroadToPreTrust('C:\\Users\\alice\\repo', ['C:\\Users\\alice'])).toBe(false)
    expect(isTooBroadToPreTrust('\\\\server\\share\\repo', [])).toBe(false)
    expect(isTooBroadToPreTrust('/srv/wt', [null, undefined])).toBe(false)
  })
})
