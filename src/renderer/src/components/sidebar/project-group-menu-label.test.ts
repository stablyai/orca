import { afterEach, describe, expect, it, vi } from 'vitest'

const translate = vi.hoisted(() =>
  vi.fn((_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace('{{hostLabel}}', String(values?.hostLabel ?? ''))
  )
)

vi.mock('@/i18n/i18n', () => ({ translate }))

import { getMoveToGroupMenuLabel } from './project-group-menu-label'

describe('project group menu localization', () => {
  afterEach(() => {
    translate.mockClear()
  })

  it('uses an intent-named id for the generic action', () => {
    expect(getMoveToGroupMenuLabel()).toBe('Move to group')
    expect(translate).toHaveBeenCalledWith(
      'auto.components.sidebar.project-group-menu-label.moveToGroup',
      'Move to group'
    )
  })

  it('names the host with a semantic interpolation placeholder', () => {
    expect(getMoveToGroupMenuLabel('Work')).toBe('Move to group: Work')
    expect(translate).toHaveBeenCalledWith(
      'auto.components.sidebar.project-group-menu-label.moveToGroupForHost',
      'Move to group: {{hostLabel}}',
      { hostLabel: 'Work' }
    )
  })
})
