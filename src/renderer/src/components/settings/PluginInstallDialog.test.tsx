// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostInstallSource } from '../../../../preload/api-types'
import { PluginInstallDialog } from './PluginInstallDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

async function renderDialog(
  onInstall: (source: PluginHostInstallSource) => Promise<void>
): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<PluginInstallDialog open onOpenChange={vi.fn()} onInstall={onInstall} />)
  })
  return root
}

async function enter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

describe('PluginInstallDialog', () => {
  it('preserves local input and stays out of consent when installation fails', async () => {
    const onInstall = vi
      .fn<(source: PluginHostInstallSource) => Promise<void>>()
      .mockRejectedValue(new Error('Integrity check failed'))
    const root = await renderDialog(onInstall)
    const input = document.querySelector<HTMLInputElement>('#plugin-local-path')
    if (!input) {
      throw new Error('missing local path input')
    }
    await enter(input, 'C:\\plugins\\demo')

    await act(async () => {
      button('Install').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onInstall).toHaveBeenCalledWith({ kind: 'local-path', path: 'C:\\plugins\\demo' })
    expect(input.value).toBe('C:\\plugins\\demo')
    expect(document.body.textContent).toContain('Plugin installation failed.')
    expect(document.body.textContent).not.toContain('Review permissions')
    act(() => root.unmount())
  })

  it('turns invalid-manifest failures into actionable localized guidance', async () => {
    const onInstall = vi
      .fn<(source: PluginHostInstallSource) => Promise<void>>()
      .mockRejectedValue(new Error('invalid manifest: contributes.panels.0.entry is required'))
    const root = await renderDialog(onInstall)
    const input = document.querySelector<HTMLInputElement>('#plugin-local-path')
    if (!input) {
      throw new Error('missing local path input')
    }
    await enter(input, '/plugins/demo')

    await act(async () => {
      button('Install').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(
      'orca-plugin.json is invalid. Ask the plugin author to fix the manifest.'
    )
    act(() => root.unmount())
  })
})
