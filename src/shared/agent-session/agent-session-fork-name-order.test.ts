import { expect, it } from 'vitest'
import { FORK_MARKED_NAME_SLOTS, forkMarkedNameParts } from './agent-session-fork-name-order'

const { mark, name } = FORK_MARKED_NAME_SLOTS

it('keeps a translation that puts the name before the mark', () => {
  expect(forkMarkedNameParts(`${name} (${mark})`).map(({ key: _key, ...part }) => part)).toEqual([
    { kind: 'name' },
    { kind: 'text', text: ' (' },
    { kind: 'mark' },
    { kind: 'text', text: ')' }
  ])
})

it('falls back to the English order when a translation drops a placeholder', () => {
  expect(forkMarkedNameParts(`Fork ${name}`).map(({ key: _key, ...part }) => part)).toEqual([
    { kind: 'mark' },
    { kind: 'text', text: ' ' },
    { kind: 'name' }
  ])
})
