import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import russian from '@/i18n/test-resources/runtime-source-grammar.json'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'confirm-orca-yaml-hooks' as string | null,
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    markOrcaHookScriptConfirmed: vi.fn(),
    markOrcaHookRepoAlwaysTrusted: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

function decodeHtml(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

describe('OrcaYamlTrustDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
    mocks.state.activeModal = 'confirm-orca-yaml-hooks'
    mocks.state.modalData = {
      repoId: 'repo-1',
      repoName: 'orca',
      scriptKind: 'setup',
      scriptContent: 'node config/scripts/run-internal-dev-setup.mjs\npnpm install',
      contentHash: 'hash-1',
      previouslyApproved: false
    }
  })

  it('keeps spaces around orca.yaml and the repo name in the first-run copy', async () => {
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain("This repository's orca.yaml runs on your machine")
    expect(text).toContain('Only run it if you trust orca.')
    expect(text).toContain('Always trust orca.yaml in orca')
    expect(text).not.toContain("repository'sorca.yaml")
    expect(text).not.toContain('trustorca')
    expect(text).not.toContain('trustorca.yaml')
    expect(text).not.toContain('inorca')
  })

  it('keeps spaces around orca.yaml when the script changed since last approval', async () => {
    mocks.state.modalData = {
      ...mocks.state.modalData,
      previouslyApproved: true
    }
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain('orca.yaml changed since you last approved')
    expect(text).toContain('Always trust orca.yaml in orca')
    expect(text).not.toContain('Always trustorca.yaml')
    expect(text).not.toContain('inorca')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each([
    ['setup', 'сценарий настройки', 'при создании этого рабочего пространства'],
    ['archive', 'сценарий архивации', 'при удалении этого рабочего пространства'],
    [
      'issueCommand',
      'команда задачи',
      'при запуске этого рабочего пространства со связанной задачей'
    ],
    ['vmRecipe', 'рецепт виртуальной машины', 'перед подготовкой виртуальной машины']
  ])(
    'localizes %s labels and triggers while retaining literal code and repository names',
    async (scriptKind, label, trigger) => {
      i18n.addResourceBundle('ru', 'translation', russian, true, true)
      await i18n.changeLanguage('ru')
      mocks.state.modalData = {
        ...mocks.state.modalData,
        scriptKind,
        repoName: '<external-repo>&name'
      }
      const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
      for (const previouslyApproved of [false, true]) {
        mocks.state.modalData.previouslyApproved = previouslyApproved
        const markup = renderToStaticMarkup(<OrcaYamlTrustDialog />)
        const text = decodeHtml(markup.replace(/<[^>]+>/g, ''))
        expect(text).toContain(label)
        expect(text).toContain(trigger)
        expect(text).toContain('<external-repo>&name')
        expect(text).toContain('node config/scripts/run-internal-dev-setup.mjs\npnpm install')
        expect(markup).toContain('<code>orca.yaml</code>')
        expect(text).not.toMatch(
          /when this workspace|before provisioning|New |setup script|issueCommand script/
        )
      }
      expect(mocks.state.markOrcaHookScriptConfirmed).not.toHaveBeenCalled()
      expect(mocks.state.markOrcaHookRepoAlwaysTrusted).not.toHaveBeenCalled()
    }
  )

  it('localizes the missing repository name without requiring a grammatical case from it', async () => {
    i18n.addResourceBundle('ru', 'translation', russian, true, true)
    await i18n.changeLanguage('ru')
    delete mocks.state.modalData.repoName
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />).replace(/<[^>]+>/g, ''))
    expect(text).toContain('репозитория «этот репозиторий»')
    expect(text).not.toContain('this repository')
  })
})
