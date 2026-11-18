// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar/activity-bar-buttons'

const item: ActivityBarItem = {
  id: 'bot-activity',
  icon: Activity,
  title: 'Activity',
  shortcut: ''
}

function renderButton(count: number | undefined, active: boolean) {
  return render(
    <TooltipProvider>
      <ActivityBarButton
        item={count ? { ...item, count } : item}
        active={active}
        onClick={() => {}}
        layout="top"
      />
    </TooltipProvider>
  )
}

describe('an activity tab with something new inside', () => {
  it('shows the count until the tab is open', () => {
    const { unmount } = renderButton(2, false)
    expect(screen.getByRole('button', { name: 'Activity, 2 new' }).textContent).toBe('2')
    unmount()
    renderButton(2, true)
    expect(screen.getByRole('button').textContent).toBe('')
  })
})
