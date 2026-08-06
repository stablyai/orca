// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { i18n } from '../i18n/i18n'
import { useSettingsNavigationMetadata } from './useSettingsNavigationMetadata'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'

// Why: the Settings sidebar / Cmd+J nav labels are produced by translate() at
// build time and memoized. Before the fix the memo deps excluded the active
// locale, so a live language switch left the nav stuck in the old language
// until Settings was remounted. This pins that the labels retranslate live.

const roots: Root[] = []
let latest: SettingsNavSection[] | null = null

function Probe(): null {
  latest = useSettingsNavigationMetadata()
  return null
}

async function renderProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(Probe))
  })
}

function agentsTitle(): string | undefined {
  return latest?.find((section) => section.id === 'agents')?.title
}

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  latest = null
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  vi.restoreAllMocks()
})

it('retranslates the settings nav labels when the UI language changes live', async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  await renderProbe()
  expect(agentsTitle()).toBe('Agents')

  // Same path as the Settings → Appearance language switch.
  await act(async () => {
    await i18n.changeLanguage('es')
  })

  // Without the active-locale memo dep this stays 'Agents' (stale cache).
  expect(agentsTitle()).toBe('Agentes')
})
