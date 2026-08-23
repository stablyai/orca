import { describe, expect, it } from 'vitest'
import { looksLikeRepoLauncher } from './repo-managed-cli'

describe('looksLikeRepoLauncher', () => {
  it('accepts the official git-repo launcher shape', () => {
    expect(
      looksLikeRepoLauncher(
        '#!/usr/bin/env python3\n# git-repo\nREPO_REV = "stable"\n# https://gerrit.googlesource.com/git-repo\n'
      )
    ).toBe(true)
  })

  it('rejects unrelated scripts', () => {
    expect(looksLikeRepoLauncher('#!/bin/sh\necho hi\n')).toBe(false)
    expect(looksLikeRepoLauncher('python is great')).toBe(false)
    expect(looksLikeRepoLauncher('#!/usr/bin/env python3\nprint("hello")\n')).toBe(false)
  })
})
