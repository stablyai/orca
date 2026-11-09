// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent, getAllByRole, getByRole } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatSessionSpeedButton } from './NativeChatSessionSpeedButton'

const STANDARD = { value: 'default', label: 'Standard' }
const TIERS = [
  { value: 'priority', label: 'Fast' },
  { value: 'ultrafast', label: 'Ultrafast' }
]

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  document.body.innerHTML = ''
})

function renderSpeed(
  current: string | undefined,
  tiers: { value: string; label: string }[] = TIERS
): HTMLElement {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  act(() =>
    root.render(
      <NativeChatSessionSpeedButton
        label="Speed"
        standard={STANDARD}
        tiers={tiers}
        current={current}
        disabled={false}
        onSet={() => {}}
      />
    )
  )
  unmount = () => root.unmount()
  return getByRole(host, 'button')
}

function checkedTiers(trigger: HTMLElement): string[] {
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  })
  return getAllByRole(document.body, 'menuitemradio')
    .filter((item) => item.getAttribute('aria-checked') === 'true')
    .map((item) => item.textContent ?? '')
}

it('names no tier when the current speed is unknown', () => {
  const trigger = renderSpeed(undefined)
  expect(trigger.getAttribute('aria-label')).toBe('Speed')
  expect(checkedTiers(trigger)).toEqual([])
})

it('opens a list for a lone Flex tier instead of a Fast toggle', () => {
  const trigger = renderSpeed('flex', [{ value: 'flex', label: 'flex' }])
  expect(trigger.getAttribute('aria-pressed')).toBeNull()
  expect(trigger.getAttribute('aria-label')).toBe('Speed: flex')
})
