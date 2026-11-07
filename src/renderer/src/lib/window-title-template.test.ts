import { describe, expect, it } from 'vitest'
import { renderWindowTitle } from './window-title-template'

describe('renderWindowTitle', () => {
  it('fills variables and joins segments with the separator', () => {
    expect(
      renderWindowTitle(
        '${appName}${separator}${repo} / ${worktree} [${issueKey}]${separator}${tab}',
        {
          appName: 'Orca',
          repo: 'orca',
          worktree: 'fix-login',
          issueKey: 'ENG-42',
          tab: 'claude'
        }
      )
    ).toBe('Orca — orca / fix-login [ENG-42] — claude')
  })

  it('drops text around empty values without gluing neighbours together', () => {
    const template = '${appName}${separator}${repo} / ${worktree} [${issueKey}]${separator}${tab}'
    expect(renderWindowTitle(template, { appName: 'Orca', worktree: 'notes' })).toBe('Orca — notes')
    expect(
      renderWindowTitle('${repo} ${branch} ${worktree}', { repo: 'orca', worktree: 'notes' })
    ).toBe('orca notes')
    expect(
      renderWindowTitle('${repo} - ${issueKey} - ${worktree}', {
        repo: 'orca',
        worktree: 'fix-login'
      })
    ).toBe('orca - fix-login')
    expect(
      renderWindowTitle('${repo} ${branch} [${issueKey}]', { repo: 'orca', issueKey: 'ENG-42' })
    ).toBe('orca [ENG-42]')
  })

  it('strips control and bidi characters and caps long values', () => {
    expect(renderWindowTitle('${tab}', { tab: 'build\u202Eexe.txt\u0007' })).toBe('buildexe.txt')
    expect(renderWindowTitle('${tab}', { tab: 'x'.repeat(200) })).toBe(`${'x'.repeat(120)}…`)
  })

  it('keeps unknown variables literal', () => {
    expect(renderWindowTitle('${branch}${separator}${nope}', { branch: 'feature/x' })).toBe(
      'feature/x — ${nope}'
    )
  })
})
