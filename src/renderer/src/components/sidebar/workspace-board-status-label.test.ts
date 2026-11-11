import { expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: () => {
    throw new Error('Custom status must not be translated')
  }
}))

import { translateWorkspaceBoardStatusLabel } from './workspace-board-status-label'

it('preserves a configured status name even when it matches a default', () => {
  expect(translateWorkspaceBoardStatusLabel({ id: 'custom', label: 'Todo' })).toBe('Todo')
})
