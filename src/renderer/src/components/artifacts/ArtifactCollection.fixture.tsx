import { useRef } from 'react'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { RailPage } from '@/components/rail-page/RailPage'
import { RailPageHeader } from '@/components/rail-page/RailPageHeader'
import { ArtifactCollection } from './ArtifactCollection'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function artifact(
  slug: string,
  title: string,
  type: 'text/html' | 'text/markdown',
  byteSize: number,
  updatedAgoMs: number,
  expiresInMs: number
): ArtifactListItem {
  const now = Date.now()
  return {
    shareUrl: `https://example.com/a/${slug}`,
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: null,
      sourceContentType: type,
      renderedContentType: 'text/html',
      createdAt: new Date(now - updatedAgoMs - DAY_MS).toISOString(),
      updatedAt: new Date(now - updatedAgoMs).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      byteSize,
      deletedAt: null
    }
  }
}

const ARTIFACTS: readonly ArtifactListItem[] = [
  artifact('a1', 'Sample roadmap draft', 'text/markdown', 4_812, 2 * HOUR_MS, 29 * DAY_MS),
  artifact('a2', 'Example pricing page', 'text/html', 18_406, 5 * HOUR_MS, 4 * DAY_MS),
  artifact('a3', 'Demo onboarding checklist', 'text/markdown', 2_190, 2 * DAY_MS, 25 * DAY_MS),
  artifact('a4', 'Placeholder release notes', 'text/markdown', 7_604, 4 * DAY_MS, 6 * DAY_MS),
  artifact('a5', 'Mock dashboard report', 'text/html', 96_120, 12 * DAY_MS, 18 * DAY_MS),
  artifact('a6', 'Test agenda outline', 'text/markdown', 1_024, 40 * DAY_MS, -DAY_MS)
]

function Scene(): React.JSX.Element {
  const clearSelectionRef = useRef<(() => boolean) | null>(null)
  return (
    <div style={{ height: 460 }} className="flex">
      <RailPage as="main">
        <RailPageHeader title="Artifacts" count={ARTIFACTS.length} />
        <ArtifactCollection
          artifacts={ARTIFACTS}
          deletingSlugs={new Set()}
          selectedSlug={null}
          selectArtifact={() => {}}
          deleteArtifacts={async () => {}}
          clearSelectionRef={clearSelectionRef}
          hasMore={false}
          loadingMore={false}
          loadMore={() => {}}
        />
      </RailPage>
    </div>
  )
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function pointerDown(element: Element | null | undefined): void {
  element?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
  )
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find((item) =>
    item.textContent?.trim().startsWith(label)
  )
}

async function openFilterSubmenu(frame: HTMLElement, label: string): Promise<void> {
  pointerDown(frame.querySelector('[data-rail-page-filter]'))
  await settle()
  const trigger = menuItem(label)
  trigger?.focus()
  trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await settle()
}

async function checkType(frame: HTMLElement, typeLabel: string): Promise<void> {
  await openFilterSubmenu(frame, 'Type')
  menuItem(typeLabel)?.click()
  await settle()
}

function closeMenus(): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  )
}

function rowCheckbox(frame: HTMLElement, index: number): HTMLElement | undefined {
  // The header's Select all is the first checkbox.
  return Array.from(frame.querySelectorAll<HTMLElement>('[data-slot="checkbox"]'))[index + 1]
}

export const wide = defineFixture({ width: 960, render: () => <Scene /> })

export const narrow = defineFixture({ width: 420, render: () => <Scene /> })

export const filterMenuOpen = defineFixture({
  width: 960,
  render: () => <Scene />,
  interact: (frame) => openFilterSubmenu(frame, 'Type')
})

export const filterChips = defineFixture({
  width: 960,
  render: () => <Scene />,
  interact: async (frame) => {
    await checkType(frame, 'Markdown')
    closeMenus()
    await settle()
    await openFilterSubmenu(frame, 'Updated')
    menuItem('Past 30 days')?.click()
    await settle()
  }
})

export const filterChipsNarrow = defineFixture({
  width: 420,
  render: () => <Scene />,
  interact: async (frame) => {
    await checkType(frame, 'Markdown')
    closeMenus()
    await settle()
  }
})

export const sortedByName = defineFixture({
  width: 960,
  render: () => <Scene />,
  interact: async (frame) => {
    Array.from(frame.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Name')
      ?.click()
    await settle()
  }
})

export const selection = defineFixture({
  width: 960,
  render: () => <Scene />,
  interact: async (frame) => {
    rowCheckbox(frame, 1)?.click()
    await settle(50)
    rowCheckbox(frame, 3)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await settle()
  }
})

export const selectionNarrow = defineFixture({
  width: 420,
  render: () => <Scene />,
  interact: async (frame) => {
    rowCheckbox(frame, 0)?.click()
    await settle(50)
    rowCheckbox(frame, 2)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await settle()
  }
})

/** HTML that has expired: no sample matches, so the empty line and its Clear filters show. */
export const emptyResult = defineFixture({
  width: 960,
  render: () => <Scene />,
  interact: async (frame) => {
    await openFilterSubmenu(frame, 'Expires')
    menuItem('Expired')?.click()
    await settle()
    closeMenus()
    await settle()
    await checkType(frame, 'HTML')
    closeMenus()
    await settle()
  }
})
