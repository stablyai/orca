// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserCookieImportPicker } from './browser-cookie-import-picker'
import {
  readBrowserCookieImportLastUsed,
  rememberBrowserCookieImportLastUsed
} from './browser-cookie-import-last-used'
import type { DetectedBrowserEntry } from './browser-toolbar-import-cookies-item'

const BROWSERS: DetectedBrowserEntry[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    profiles: Array.from({ length: 12 }, (_, index) => ({
      name: index === 0 ? 'Person 1' : `Client ${index}`,
      directory: index === 0 ? 'Default' : `Profile ${index}`
    })),
    selectedProfile: 'Default'
  },
  {
    family: 'safari',
    label: 'Safari',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onImportFromBrowser = vi.fn<(family: string, profile?: string) => void>()
const onImportFromFile = vi.fn<() => void>()

function Harness(): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(true)
  return (
    <>
      <button ref={anchorRef} type="button" aria-label="Browser menu" />
      <BrowserCookieImportPicker
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        browserPageId="page-1"
        detectedBrowsers={BROWSERS}
        pageRoute={{ kind: 'local' }}
        onImportFromBrowser={onImportFromBrowser}
        onImportFromFile={onImportFromFile}
      />
    </>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  onImportFromBrowser.mockClear()
  onImportFromFile.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

let mounts = 0
async function mount(): Promise<void> {
  mounts += 1
  await act(async () => {
    // A fresh key opens a fresh picker, as each Import Cookies… click does.
    root.render(<Harness key={mounts} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const picker = (): HTMLElement | null =>
  document.querySelector('[data-testid="browser-cookie-import-picker"]')
const input = (): HTMLInputElement => {
  const el = picker()?.querySelector<HTMLInputElement>('input')
  if (!el) {
    throw new Error('picker input missing')
  }
  return el
}
const rowLabels = (): string[] =>
  [...(picker()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].map(
    (row) => row.textContent ?? ''
  )
const headings = (): string[] =>
  [...(picker()?.querySelectorAll<HTMLElement>('[cmdk-group-heading]') ?? [])].map(
    (h) => h.textContent ?? ''
  )
const highlighted = (): string | null =>
  picker()?.querySelector('[cmdk-item][data-selected="true"]')?.textContent ?? null

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('the Import Cookies picker', () => {
  it('opens on the search field with browsers as sections and From File… last', async () => {
    await mount()
    expect(document.activeElement).toBe(input())
    expect(input().placeholder).toBe('Search profiles')
    expect(headings()).toEqual(['Google Chrome', 'Safari'])
    const rows = rowLabels()
    expect(rows).toHaveLength(14)
    expect(rows.at(-2)).toBe('Safari')
    expect(rows.at(-1)).toBe('From File…')
    expect(highlighted()).toBe('Person 1')
  })

  it('shows the last source first, and only while the search is empty', async () => {
    rememberBrowserCookieImportLastUsed({ family: 'chrome', profile: 'Profile 3' })
    await mount()
    expect(headings()[0]).toBe('Last used')
    expect(highlighted()).toBe('Google Chrome · Client 3')
    await type('client 1')
    expect(headings()).toEqual(['Google Chrome'])
    expect(rowLabels()).toEqual(['Client 1', 'Client 10', 'Client 11', 'From File…'])
    expect(highlighted()).toBe('Client 1')
  })

  it('says No matches when nothing fits, keeping From File…', async () => {
    await mount()
    await type('zzz')
    expect(picker()?.textContent).toContain('No matches')
    expect(rowLabels()).toEqual(['From File…'])
  })

  it('moves the highlight with the arrows and imports the row on Enter', async () => {
    await mount()
    await press('ArrowDown')
    await press('ArrowDown')
    expect(highlighted()).toBe('Client 2')
    await press('ArrowUp')
    expect(highlighted()).toBe('Client 1')
    await press('Enter')
    expect(onImportFromBrowser).toHaveBeenCalledWith('chrome', 'Profile 1')
    expect(readBrowserCookieImportLastUsed()).toEqual({ family: 'chrome', profile: 'Profile 1' })
    expect(picker()).toBeNull()
  })

  it('scrolls the row the arrows land on into view, not the one they left', async () => {
    await mount()
    const scrolled: string[] = []
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement
    ) {
      scrolled.push(this.textContent ?? '')
    })
    try {
      await press('ArrowDown')
      expect(highlighted()).toBe('Client 1')
      expect(scrolled.at(-1)).toBe('Client 1')
    } finally {
      spy.mockRestore()
    }
  })

  it('imports a one-profile browser without naming a profile', async () => {
    await mount()
    await type('safari')
    await press('Enter')
    expect(onImportFromBrowser).toHaveBeenCalledWith('safari', undefined)
    expect(readBrowserCookieImportLastUsed()).toEqual({ family: 'safari', profile: null })
  })

  it('imports a clicked row, and From File… opens the file import', async () => {
    await mount()
    const row = [...(picker()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].find(
      (el) => el.textContent === 'Client 5'
    )
    await act(async () => row?.click())
    expect(onImportFromBrowser).toHaveBeenCalledWith('chrome', 'Profile 5')

    await mount()
    const file = [...(picker()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].find(
      (el) => el.textContent === 'From File…'
    )
    await act(async () => file?.click())
    expect(onImportFromFile).toHaveBeenCalledTimes(1)
    expect(picker()).toBeNull()
  })

  it('closes on Escape and gives focus back to the ⋯ button', async () => {
    await mount()
    await press('Escape')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(picker()).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Browser menu')
    expect(onImportFromBrowser).not.toHaveBeenCalled()
  })
})
