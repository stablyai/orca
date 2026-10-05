import { describe, expect, it } from 'vitest'
import { looksLikeMantisBTAuthError } from './mantisbt-read-coordination'

const ipcError = (detail: string): Error =>
  new Error(`Error invoking remote method 'mantisBT:listIssues': Error: ${detail}`)

describe('looksLikeMantisBTAuthError', () => {
  it('treats a 401 as auth loss even when the server text has no auth wording', () => {
    expect(looksLikeMantisBTAuthError(ipcError('Error 401: Access denied'))).toBe(true)
    expect(looksLikeMantisBTAuthError(ipcError('Error 401: API token not found'))).toBe(true)
  })

  it('does not treat a 403 permission denial as auth loss', () => {
    expect(looksLikeMantisBTAuthError(ipcError('Error 403: Access denied'))).toBe(false)
  })

  it('trusts the status over wording that mentions authentication', () => {
    expect(looksLikeMantisBTAuthError(ipcError('Error 500: authentication backend down'))).toBe(
      false
    )
  })
})
