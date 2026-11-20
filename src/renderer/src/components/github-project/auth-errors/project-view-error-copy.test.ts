import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { projectViewErrorMessage } from './project-view-error-copy'

const localize: Translate = (key, _fallback, options) => `${key}: ${String(options?.command)}`

describe('projectViewErrorMessage', () => {
  it.each([
    {
      type: 'auth_required' as const,
      expected: 'projectViews.error.authRequired: gh auth login'
    },
    {
      type: 'scope_missing' as const,
      expected: 'projectViews.error.scopeMissing: gh auth refresh -s project -s read:org -s repo'
    }
  ])('localizes host-less $type guidance', ({ type, expected }) => {
    expect(projectViewErrorMessage({ type, message: 'English fallback' }, {}, localize)).toBe(
      expected
    )
  })
})
