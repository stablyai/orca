import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { AppRail } from './AppRail'

// Tall enough for every page plus "…"; the short one folds into More.
const TALL_PX = 420
const SHORT_PX = 200

function RailFrame({ height }: { height: number }): React.JSX.Element {
  return (
    <div className="flex bg-background" style={{ height }}>
      <AppRail listVisible />
      <div className="w-[220px] bg-worktree-sidebar" />
    </div>
  )
}

// The web bridge has no runtime here; echo writes back so toggles land in the store as they do in the app.
function echoSettingsWrites(overrides: Partial<GlobalSettings> = {}): void {
  useAppStore.setState((state) =>
    state.settings
      ? { settings: { ...state.settings, experimentalAppRail: true, ...overrides } }
      : {}
  )
  window.api.settings.set = async (updates) => {
    const current = useAppStore.getState().settings
    if (!current) {
      throw new Error('The fixture store has no settings to update.')
    }
    return { ...current, ...updates }
  }
}

function click(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector)
  element?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  element?.click()
}

const openCustomize = (): void => click('[data-app-rail-item="customize"]')

export const tall = defineFixture({
  width: 300,
  setup: () => echoSettingsWrites(),
  render: () => <RailFrame height={TALL_PX} />
})

export const customizeOpen = defineFixture({
  width: 300,
  setup: () => echoSettingsWrites(),
  render: () => <RailFrame height={TALL_PX} />,
  interact: openCustomize
})

export const skillsOn = defineFixture({
  width: 300,
  setup: () => echoSettingsWrites({ showSkillsButton: true }),
  render: () => <RailFrame height={TALL_PX} />,
  interact: openCustomize
})

export const shortFolded = defineFixture({
  width: 300,
  setup: () => echoSettingsWrites(),
  render: () => <RailFrame height={SHORT_PX} />
})

export const shortMoreOpen = defineFixture({
  width: 420,
  setup: () => echoSettingsWrites(),
  render: () => <RailFrame height={SHORT_PX} />,
  interact: async () => {
    click('[data-app-rail-item="more"]')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sub = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    ).find((element) => element.textContent?.includes('Customize'))
    sub?.focus()
    sub?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
