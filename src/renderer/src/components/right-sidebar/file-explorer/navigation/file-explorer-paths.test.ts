import { expect, it } from 'vitest'
import { getRevealTargetPath } from './file-explorer-paths'

it('re-spells a forward-slash reveal target to match a Windows root', () => {
  expect(getRevealTargetPath('C:\\Projects\\other', 'C:/Projects/other/docs/api')).toBe(
    'C:\\Projects\\other\\docs\\api'
  )
})
