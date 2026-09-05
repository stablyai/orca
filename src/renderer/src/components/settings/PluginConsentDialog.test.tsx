// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS } from '../../../../shared/plugins/plugin-read-confinement'
import { i18n } from '../../i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '../../i18n/pseudo-localization'
import { PluginConsentDialog } from './PluginConsentDialog'

const plugin: PluginHostListEntry = {
  pluginKey: 'acme.worker',
  consentFingerprint: 'sha256-acme-worker',
  name: 'Acme Worker',
  version: '1.2.3',
  publisher: 'acme',
  status: 'pending',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [{ kind: 'workspace:list', description: 'Run a background worker process' }],
  panels: [],
  commands: [],
  hasWorker: true,
  restarts: 0,
  source: {
    kind: 'git',
    reference: 'https://gitlab.example/acme/worker#v1.2.3',
    resolvedCommit: '0123456789abcdef',
    contentHash: 'sha256'
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: {} }
  })
})

afterEach(async () => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'api')
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle(PSEUDO_LOCALIZATION_LOCALE, 'translation')
})

async function renderConsent(
  entry: PluginHostListEntry,
  onDecision: (
    key: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  function Harness(): React.JSX.Element {
    const [selected, setSelected] = useState<PluginHostListEntry | null>(entry)
    return (
      <PluginConsentDialog
        plugin={selected}
        onDecision={async (key, reviewedFingerprint, decision) => {
          await onDecision(key, reviewedFingerprint, decision)
          setSelected(null)
        }}
      />
    )
  }
  await act(async () => root.render(<Harness />))
  await act(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
}

describe('PluginConsentDialog', () => {
  it('shows a scoped file grant and the exact host-enforced exclusions', async () => {
    await renderConsent(
      {
        ...plugin,
        capabilities: [
          {
            kind: 'files:read',
            paths: ['**', 'docs/**/*.md'],
            description: 'Read files inside worktrees'
          }
        ]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent).toContain('Whole worktree')
    expect(
      Array.from(document.querySelectorAll('ul[aria-label="Whole worktree"] > li')).map(
        (item) => item.textContent
      )
    ).toEqual(['**', 'docs/**/*.md'])
    expect(
      Array.from(document.querySelectorAll('ul[aria-label="Always blocked"] > li')).map(
        (item) => item.textContent
      )
    ).toEqual(PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS)
    expect(document.activeElement?.textContent).toContain('Keep Disabled')
  })

  it('keeps expanded localized prose in the existing accessible scroll contract', async () => {
    const doubled = 'Read files in your worktrees that match these patterns '.repeat(2).trim()
    i18n.addResourceBundle(
      PSEUDO_LOCALIZATION_LOCALE,
      'translation',
      {
        auto: {
          components: {
            settings: {
              PluginConsentDialog: { capability: { filesRead: doubled } }
            }
          }
        }
      },
      true,
      true
    )
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)

    await renderConsent(
      {
        ...plugin,
        capabilities: [
          { kind: 'files:read', paths: ['src/**'], description: 'Read files inside worktrees' }
        ]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain(doubled)
    expect(dialog?.classList).toContain('max-h-[calc(100vh-3rem)]')
    expect(dialog?.classList).toContain('overflow-y-auto')
    expect(dialog?.classList).toContain('scrollbar-sleek')
    expect(dialog?.querySelectorAll('[class*="overflow-y"]')).toHaveLength(0)
    expect(dialog?.querySelector('ul li')?.textContent).toBe('src/**')
    expect(dialog?.querySelector('ul li')?.classList).toContain('break-all')
    expect(dialog?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(
      dialog?.querySelector('ul')?.closest('.min-w-0')?.querySelectorAll('button, a')
    ).toHaveLength(0)
  })

  it('keeps the displayed fingerprint immutable during a same-key update', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onDecision = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<PluginConsentDialog plugin={plugin} onDecision={onDecision} />)
    })
    await act(async () => {
      root.render(
        <PluginConsentDialog
          plugin={{
            ...plugin,
            consentFingerprint: 'sha256-unreviewed-update',
            capabilities: [{ kind: 'secrets', description: 'Read a newly added secret' }]
          }}
          onDecision={onDecision}
        />
      )
    })

    expect(document.body.textContent).not.toContain('Read a newly added secret')
    const enable = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Enable plugin'
    )
    await act(async () => enable?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onDecision).toHaveBeenCalledWith(plugin.pluginKey, plugin.consentFingerprint, 'approve')
  })

  it('shows provenance, capabilities, worker warning, and focuses the safe default', async () => {
    await renderConsent(plugin, vi.fn().mockResolvedValue(undefined))

    // Provenance leads with a short badge + a short trust chip; the full
    // source URL and commit are tucked behind the "Source" details popover.
    expect(document.body.textContent).toContain(plugin.publisher)
    expect(document.body.textContent).toContain('Worker')
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Source'
      )
    ).toBe(true)
    expect(document.body.textContent).toContain(
      'Read the name, branch, and host of all your worktrees'
    )
    expect(document.body.textContent).toContain(
      'full access to your files, network, and other processes'
    )
    expect(document.querySelector('[role="dialog"]')?.classList).toContain('plugin-security-chrome')
    expect(document.activeElement?.textContent).toContain('Keep Disabled')
  })

  it('renders repeated unscoped capabilities without duplicate React-key warnings', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderConsent(
      {
        ...plugin,
        capabilities: [
          { kind: 'workspace:list', description: 'List worktrees' },
          { kind: 'workspace:list', description: 'List worktrees' }
        ]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent?.match(/\(workspace:list\)/g)).toHaveLength(2)
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
  })

  it('explains that panel-only plugins have no worker process', async () => {
    await renderConsent(
      {
        ...plugin,
        pluginKey: 'acme.panel',
        name: 'Acme Panel',
        hasWorker: false,
        capabilities: [{ kind: 'workspace:list', description: 'Add an Acme panel' }]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent).toContain(
      "These permissions limit how the plugin uses Orca's API. This plugin has no background worker."
    )
    expect(document.body.textContent).not.toContain('full access to your files')
  })

  it('describes inert content without pretending it requested permissions', async () => {
    await renderConsent(
      {
        ...plugin,
        pluginKey: 'acme.icons',
        name: 'Acme Icons',
        hasWorker: false,
        capabilities: []
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent).toContain('Review plugin')
    expect(document.body.textContent).toContain('Declarative')
    expect(document.body.textContent).toContain(
      "This plugin contributes validated content only. It does not run a background worker or receive access to Orca's API."
    )
    expect(document.body.textContent).not.toContain('These permissions limit')
  })

  it('shows every VM recipe lifecycle command verbatim', async () => {
    await renderConsent(
      {
        ...plugin,
        hasWorker: false,
        capabilities: [],
        vmRecipes: [
          {
            id: 'cloud',
            name: 'Cloud Sandbox',
            description: 'Creates a disposable VM.',
            commands: [
              { phase: 'create', command: './scripts/create.sh --exact "$VALUE"' },
              { phase: 'suspend', command: './scripts/suspend.sh' },
              { phase: 'resume', command: './scripts/resume.sh' },
              { phase: 'destroy', command: 'none' }
            ]
          }
        ]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent).toContain('Instructional')
    expect(document.body.textContent).toContain('Review plugin content')
    expect(document.body.textContent).toContain(
      'Its instructional content can still cause actions when you or an agent use it.'
    )
    expect(document.body.textContent).toContain('./scripts/create.sh --exact "$VALUE"')
    expect(document.body.textContent).toContain('./scripts/suspend.sh')
    expect(document.body.textContent).toContain('./scripts/resume.sh')
    expect(document.body.textContent).toContain('Destroynone')
    const commands = Array.from(document.querySelectorAll('pre'))
    expect(commands).toHaveLength(4)
    expect(commands[0]?.tabIndex).toBe(0)
    expect(commands[0]?.getAttribute('aria-label')).toBe('Cloud Sandbox · Create command')
  })

  it('shows plugin shortcuts and names built-in chords they replace', async () => {
    await renderConsent(
      {
        ...plugin,
        hasWorker: false,
        capabilities: [],
        commands: [
          {
            id: 'tasks',
            title: 'Open Tasks',
            context: 'global',
            handler: { type: 'built-in', action: 'view.tasks' },
            keybindings: [{ key: 'Mod+P', when: 'global' }]
          }
        ]
      },
      vi.fn().mockResolvedValue(undefined)
    )

    expect(document.body.textContent).toContain('Review plugin content')
    expect(document.body.textContent).toContain('Keyboard shortcuts')
    expect(document.body.textContent).toContain('Open Tasks')
    expect(document.body.textContent).toContain('Replaces: Go to File')
  })

  it('records Keep Disabled when Escape dismisses the dialog', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined)
    await renderConsent(plugin, onDecision)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onDecision).toHaveBeenCalledWith(
      plugin.pluginKey,
      plugin.consentFingerprint,
      'keep-disabled'
    )
  })

  it('locks duplicate decisions immediately without changing reviewed scope or focus', async () => {
    let finishDecision: (() => void) | undefined
    const onDecision = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDecision = resolve
          setTimeout(resolve, 100)
        })
    )
    await renderConsent(
      {
        ...plugin,
        capabilities: [
          {
            kind: 'files:read',
            paths: ['src/**/*.ts', 'docs/**/*.md'],
            description: 'Read files inside worktrees'
          }
        ]
      },
      onDecision
    )
    const buttons = Array.from(document.querySelectorAll('button'))
    const keepDisabled = buttons.find((button) => button.textContent?.trim() === 'Keep Disabled')
    const enable = buttons.find((button) => button.textContent?.trim() === 'Enable plugin')
    if (!keepDisabled || !enable) {
      throw new Error('missing consent actions')
    }

    await act(async () => {
      enable.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })
    enable.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(enable.disabled).toBe(true)
    expect(keepDisabled.disabled).toBe(true)
    expect(document.activeElement).toBe(keepDisabled)
    expect(enable.parentElement).toBe(keepDisabled.parentElement)
    expect(
      Array.from(document.querySelectorAll('ul[aria-label="File patterns"] > li')).map(
        (item) => item.textContent
      )
    ).toEqual(['src/**/*.ts', 'docs/**/*.md'])

    await act(async () => finishDecision?.())
  })

  it('labels re-consent generically and enables only after an explicit action', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined)
    await renderConsent({ ...plugin, needsReconsent: true }, onDecision)
    expect(document.body.textContent).toContain(
      'Permissions, the worker trust tier, or instructional content changed'
    )
    const enable = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Enable plugin'
    )
    if (!enable) {
      throw new Error('missing enable action')
    }

    await act(async () => enable.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onDecision).toHaveBeenCalledWith(plugin.pluginKey, plugin.consentFingerprint, 'approve')
  })

  it('explains how to recover when the reviewed plugin changed', async () => {
    const onDecision = vi
      .fn()
      .mockRejectedValue(new Error('reviewed fingerprint is no longer current'))
    await renderConsent(plugin, onDecision)
    const enable = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Enable plugin'
    )

    await act(async () => enable?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.body.textContent).toContain(
      'The plugin changed while you were reviewing it. Close this dialog and review the updated permissions.'
    )
  })
})
