import { beforeEach, describe, expect, it, vi } from 'vitest'
import { linearLabelCountLabel, linearMemberCountLabel } from './linear-attribute-count-labels'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string, fallback: string) => `${key}:${fallback}`)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('Linear attribute count labels', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses the singular sentence for one label and the plural one above that', () => {
    expect(linearLabelCountLabel(1)).toBe(
      'auto.components.TaskPage.labelCountSingular:{{count}} label'
    )
    expect(linearLabelCountLabel(3)).toBe(
      'auto.components.TaskPage.labelCountPlural:{{count}} labels'
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.TaskPage.labelCountSingular',
      '{{count}} label',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.TaskPage.labelCountPlural',
      '{{count}} labels',
      { count: 3 }
    )
  })

  it('uses the singular sentence for one member and the plural one above that', () => {
    expect(linearMemberCountLabel(1)).toBe(
      'auto.components.TaskPage.memberCountSingular:{{count}} member'
    )
    expect(linearMemberCountLabel(2)).toBe(
      'auto.components.TaskPage.memberCountPlural:{{count}} members'
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.TaskPage.memberCountSingular',
      '{{count}} member',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.TaskPage.memberCountPlural',
      '{{count}} members',
      { count: 2 }
    )
  })
})
