// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { findInstalledAgentChoice } from './installed-agent-choice-reveal'

afterEach(() => {
  document.body.replaceChildren()
})

type Choice = { label: string; checked?: boolean; unavailable?: boolean }

function installedList(...rows: Choice[][]): HTMLElement {
  const list = document.createElement('section')
  const body = document.createElement('div')
  body.dataset.settingsGroupBody = ''
  for (const choices of rows) {
    const row = document.createElement('div')
    row.dataset.agentOpensAs = ''
    const group = document.createElement('div')
    group.setAttribute('role', 'radiogroup')
    for (const choice of choices) {
      const radio = document.createElement('button')
      radio.setAttribute('role', 'radio')
      radio.setAttribute('aria-checked', String(Boolean(choice.checked)))
      if (choice.unavailable) {
        radio.setAttribute('aria-disabled', 'true')
      }
      radio.textContent = choice.label
      group.append(radio)
    }
    row.append(group)
    body.append(row)
  }
  list.append(body)
  document.body.append(list)
  return list
}

const name = (list: HTMLElement): string | null =>
  findInstalledAgentChoice(list)?.textContent ?? null

it("lands on the first row's current choice", () => {
  expect(name(installedList([{ label: 'Chat' }, { label: 'CLI', checked: true }]))).toBe('CLI')
})

it('passes over a current choice that cannot be picked for another in the same row', () => {
  const list = installedList([
    { label: 'Chat' },
    { label: 'CLI', checked: true, unavailable: true }
  ])
  expect(name(list)).toBe('Chat')
})

it('skips a disabled agent for the next row with a choice', () => {
  const list = installedList(
    [
      { label: 'Chat', checked: true, unavailable: true },
      { label: 'CLI', unavailable: true }
    ],
    [{ label: 'Chat' }, { label: 'CLI', checked: true }]
  )
  expect(findInstalledAgentChoice(list)).toBe(list.querySelectorAll('[role="radio"]')[3])
})

it('finds nothing when no installed agent has a choice to pick', () => {
  expect(name(installedList([{ label: 'Chat', checked: true, unavailable: true }]))).toBeNull()
})
