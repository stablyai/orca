export type DoubaoSignInStatus = 'signed-in' | 'signed-out' | 'unverified'

/** The status command can fail offline or print account IDs. Only return its verified verdict. */
export function classifyDoubaoSignIn(result: {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}): DoubaoSignInStatus {
  if (result.timedOut || result.code === null) {
    return 'unverified'
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (/^login_required:|(?:当前未登录|登录凭据或账号身份已失效)[，,]/mu.test(output)) {
    return 'signed-out'
  }
  return result.code === 0 && output.includes('登录成功，账号已通过验证')
    ? 'signed-in'
    : 'unverified'
}
