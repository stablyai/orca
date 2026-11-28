import React, { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import PRFilterDropdowns, { type PRFilterChange } from './PRFilterDropdowns'
import { parseTaskQuery } from '../../../../shared/work-items/task-query'
import { patchGitHubTaskQuery } from '../task-page/github/listing/task-page-pr-chips'

const DEFAULT_QUERY = 'is:open'

function PRFilterFixture({
  initialQuery = DEFAULT_QUERY,
  activeCount = 0
}: {
  initialQuery?: string
  activeCount?: number
}): React.JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const parsed = parseTaskQuery(query)
  const defaultFilters = parseTaskQuery(DEFAULT_QUERY)
  const handleChange = (change: PRFilterChange): void => {
    setQuery((current) => patchGitHubTaskQuery(current, change))
  }
  return (
    <div className="flex min-h-[340px] justify-end bg-background p-3 text-foreground">
      <PRFilterDropdowns
        parsed={parsed}
        defaultFilters={defaultFilters}
        activeCount={activeCount}
        kind="prs"
        authorLogins={['octocat', 'very-long-organization-maintainer-username-2026']}
        primarySlug={null}
        onChange={handleChange}
      />
    </div>
  )
}

async function openFilterMenu(frame: HTMLElement): Promise<void> {
  const trigger = frame.querySelector<HTMLButtonElement>('[data-rail-page-filter]')
  if (!trigger) {
    return
  }
  trigger.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
  )
  trigger.click()
  await new Promise((resolve) => setTimeout(resolve, 60))
}

async function openSubmenuByLabel(label: string): Promise<void> {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
  )
  const target = items.find((el) => el.textContent?.includes(label))
  if (!target) {
    return
  }
  target.focus()
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 80))
}

export const defaultOpen = defineFixture({
  width: 360,
  render: () => <PRFilterFixture />,
  interact: openFilterMenu
})

export const statusSubmenu = defineFixture({
  width: 520,
  render: () => <PRFilterFixture />,
  interact: async (frame) => {
    await openFilterMenu(frame)
    await openSubmenuByLabel('Status')
  }
})

export const showSubmenu = defineFixture({
  width: 520,
  render: () => <PRFilterFixture initialQuery="is:open author:@me" activeCount={1} />,
  interact: async (frame) => {
    await openFilterMenu(frame)
    await openSubmenuByLabel('Show')
  }
})

export const worstCaseNarrow = defineFixture({
  width: 240,
  render: () => (
    <PRFilterFixture
      initialQuery='is:open is:draft author:very-long-organization-maintainer-username-2026 label:"area/platform-infrastructure-long-label-name" review-requested:super-long-code-reviewer-login assignee:another-very-long-assignee-handle'
      activeCount={5}
    />
  ),
  interact: async (frame) => {
    await openFilterMenu(frame)
    const content = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')
    if (content) {
      content.style.width = '240px'
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
})

export const authorDrillIn = defineFixture({
  width: 360,
  render: () => <PRFilterFixture />,
  interact: async (frame) => {
    await openFilterMenu(frame)
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')
    )
    const authorRow = items.find((el) => el.textContent?.includes('Author'))
    authorRow?.click()
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})
