// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostInstallSource } from '../../../../../preload/api-types'
import type { PluginGitSourceResolution } from '../../../../../shared/plugins/installation/plugin-git-resolution'
import { PluginInstallDialog } from './PluginInstallDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

type ResolveGitSource = (args: { url: string; ref: string }) => Promise<PluginGitSourceResolution>

async function renderDialog(
  onInstall: (source: PluginHostInstallSource) => Promise<void>,
  resolveGitSource?: ResolveGitSource
): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PluginInstallDialog
        open
        onOpenChange={vi.fn()}
        onInstall={onInstall}
        initialKind={resolveGitSource ? 'git' : 'local-path'}
        {...(resolveGitSource ? { resolveGitSource } : {})}
      />
    )
  })
  return root
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function gitInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#plugin-git-url')
  if (!input) {
    throw new Error('missing git URL input')
  }
  return input
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

  it('shows the pinned version of a plain repository URL before installing it', async () => {
    const commit = '6060a677674a2491d818961745447073411607d8'
    const resolveGitSource = vi.fn<ResolveGitSource>().mockResolvedValue({
      ok: true,
      url: 'https://github.com/kolebayev/orca-md-layout',
      kind: 'latest-tag',
      ref: 'v0.1.0',
      commit
    })
    const onInstall = vi.fn<(source: PluginHostInstallSource) => Promise<void>>()
    const root = await renderDialog(onInstall, resolveGitSource)
    await enter(gitInput(), 'https://github.com/kolebayev/orca-md-layout')

    await click('Continue')

    expect(resolveGitSource).toHaveBeenCalledWith({
      url: 'https://github.com/kolebayev/orca-md-layout',
      ref: ''
    })
    expect(onInstall).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Installs v0.1.0, the latest version, at commit 6060a67.'
    )

    await click('Install')

    expect(onInstall).toHaveBeenCalledWith({
      kind: 'git',
      url: 'https://github.com/kolebayev/orca-md-layout',
      ref: 'v0.1.0',
      expectedCommit: commit
    })
    act(() => root.unmount())
  })

  it('checks again after the URL changes and explains a missing tag', async () => {
    const resolveGitSource = vi
      .fn<ResolveGitSource>()
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://github.com/acme/notes',
        kind: 'default-branch',
        ref: 'a'.repeat(40),
        commit: 'a'.repeat(40)
      })
      .mockResolvedValueOnce({ ok: false, reason: 'ref-not-found', ref: 'v9' })
    const onInstall = vi.fn<(source: PluginHostInstallSource) => Promise<void>>()
    const root = await renderDialog(onInstall, resolveGitSource)
    await enter(gitInput(), 'acme/notes')
    await click('Continue')
    expect(document.body.textContent).toContain('No version tag found')

    await enter(gitInput(), 'acme/notes#v9')
    await click('Continue')

    expect(resolveGitSource).toHaveBeenLastCalledWith({
      url: 'https://github.com/acme/notes',
      ref: 'v9'
    })
    expect(document.body.textContent).toContain('This repository has no tag or branch named v9.')
    expect(onInstall).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('refuses a token in the URL without contacting the repository', async () => {
    const resolveGitSource = vi.fn<ResolveGitSource>()
    const root = await renderDialog(vi.fn(), resolveGitSource)
    await enter(gitInput(), 'https://ghp_secret@github.com/acme/notes')
    await click('Continue')

    expect(resolveGitSource).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Remove the username or token from the URL.')
    act(() => root.unmount())
  })

  it('can be cancelled while the repository is still being checked', async () => {
    const onOpenChange = vi.fn()
    let finish: (value: PluginGitSourceResolution) => void = () => {}
    const resolveGitSource = vi.fn<ResolveGitSource>(
      () => new Promise((resolve) => (finish = resolve))
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginInstallDialog
          open
          onOpenChange={onOpenChange}
          onInstall={vi.fn()}
          initialKind="git"
          resolveGitSource={resolveGitSource}
        />
      )
    })
    await enter(gitInput(), 'acme/notes')
    await click('Continue')
    await click('Cancel')
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await act(async () => {
      finish({ ok: false, reason: 'unreachable', error: 'timed out' })
    })
    expect(document.body.textContent).not.toContain("Couldn't read this repository")
    act(() => root.unmount())
  })
})
