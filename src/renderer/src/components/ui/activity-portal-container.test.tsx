// @vitest-environment happy-dom
import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ActivityPortalContainer } from './activity-portal-container'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

it('hides an open popover whose pane Activity is hidden under a host element', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const pane = (visible: boolean) => (
    <ActivityPortalContainer visible={visible}>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <div>
          <Popover open>
            <PopoverTrigger>Model</PopoverTrigger>
            <PopoverContent>Search models</PopoverContent>
          </Popover>
        </div>
      </Activity>
    </ActivityPortalContainer>
  )
  await act(async () => root.render(pane(true)))
  await act(async () => root.render(pane(false)))
  const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
  expect(content?.closest('[data-activity-portal-container]')?.getAttribute('style')).toBe(
    'display: none;'
  )
  await act(async () => root.unmount())
})
