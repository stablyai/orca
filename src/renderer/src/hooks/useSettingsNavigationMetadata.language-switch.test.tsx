// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { i18n } from '../i18n/i18n'
import { useSettingsNavigationMetadata } from './useSettingsNavigationMetadata'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'

// A locale subscription rerender must also invalidate memoized Settings/Cmd+J labels.

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

  await act(async () => {
    await i18n.changeLanguage('es')
  })

  expect(agentsTitle()).toBe('Agentes')
})
