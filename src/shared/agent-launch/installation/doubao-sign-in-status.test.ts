import { describe, expect, it } from 'vitest'
import { classifyDoubaoSignIn } from './doubao-sign-in-status'

describe('Doubao sign-in verification', () => {
  it('requires an explicit verified result before reporting a signed-in account', () => {
    const verified = { code: 0, timedOut: false, stdout: '登录成功，账号已通过验证', stderr: '' }
    expect(classifyDoubaoSignIn(verified)).toBe('signed-in')
    expect(classifyDoubaoSignIn({ ...verified, stdout: '' })).toBe('unverified')
    expect(classifyDoubaoSignIn({ ...verified, timedOut: true })).toBe('unverified')
    expect(classifyDoubaoSignIn({ ...verified, code: 1 })).toBe('unverified')
    expect(
      classifyDoubaoSignIn({
        ...verified,
        code: 4,
        stdout: '',
        stderr: 'login_required: 当前未登录，请运行 `doubao login` 登录'
      })
    ).toBe('signed-out')
  })
})
