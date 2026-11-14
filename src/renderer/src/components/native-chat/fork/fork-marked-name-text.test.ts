import { expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { forkMarkedNameText, forkSourceTooltipText } from './fork-marked-name-text'

it('names a forked source with its fork mark, as the divider does', () => {
  expect(forkSourceTooltipText(translate, { name: 'Annotate', forked: true }, 'Claude Chat')).toBe(
    'Fork of Fork · Annotate'
  )
})

it('names an unnamed source by its default label, and an unknown one generically', () => {
  expect(forkSourceTooltipText(translate, { name: null, forked: false }, 'Claude Chat')).toBe(
    'Fork of Claude Chat'
  )
  expect(forkSourceTooltipText(translate, undefined, 'Claude Chat')).toBe('Fork of another chat')
})

it('spells a marked name as plain text for labels such as the close button', () => {
  expect(forkMarkedNameText(translate, 'Annotate')).toBe('Fork · Annotate')
})
