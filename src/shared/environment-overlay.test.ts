import { expect, it } from 'vitest'
import { overlayEnvironmentVariables } from './environment-overlay'

it('replaces Windows aliases in configured order while preserving untouched inherited names', () => {
  const base = { TOKEN: 'old', Token: 'also old', PATH: 'first', Path: 'second', KEEP: 'keep' }
  const configured = { token: 'first override', tOKEN: '', Custom: 'configured' }
  expect(overlayEnvironmentVariables(base, configured, 'win32')).toEqual({
    PATH: 'first',
    Path: 'second',
    KEEP: 'keep',
    TOKEN: '',
    CUSTOM: 'configured'
  })
  expect(Object.entries(base)).toEqual([
    ['TOKEN', 'old'],
    ['Token', 'also old'],
    ['PATH', 'first'],
    ['Path', 'second'],
    ['KEEP', 'keep']
  ])
  expect(configured).toEqual({ token: 'first override', tOKEN: '', Custom: 'configured' })
  expect(overlayEnvironmentVariables(base, undefined, 'win32')).toEqual(base)
  expect(overlayEnvironmentVariables({ TOKEN: 'old' }, { token: 'new' }, 'linux')).toEqual({
    TOKEN: 'old',
    token: 'new'
  })
})
