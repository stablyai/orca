// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { i18n } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import es from '@/i18n/locales/es.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'
import { NativeChatAppearancePreview } from './NativeChatAppearancePreview'
import { NativeChatDisclosureContext } from './native-chat-disclosure-store'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS
} from './native-chat-appearance-style'

const surroundingDisclosureStore = { read: vi.fn(), write: vi.fn() }

vi.mock('@/store', () => ({
  useAppStore: () => {
    throw new Error('The preview must not subscribe to application or session state')
  }
}))

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

function previewRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-native-chat-appearance-preview]')
  if (!root) {
    throw new Error('Expected the chat appearance preview')
  }
  return root
}

describe('NativeChatAppearancePreview', () => {
  it.each(Object.entries({ es, fr, ja, ko, zh }))(
    'updates the mounted sample prose to %s while preserving literal code and file names',
    async (locale, catalog) => {
      const { container } = render(
        <NativeChatAppearancePreview settings={getDefaultSettings('/tmp')} />
      )
      await act(async () => {
        await i18n.changeLanguage(locale)
      })
      const sample = catalog.settings.appearance.chat.previewSample
      for (const prose of Object.values(sample)) {
        expect(container).toHaveTextContent(prose.replace(/`|\*\*/g, ''))
      }
      expect(container).not.toHaveTextContent('Use Node instead of Unix-only syntax.')
      expect(container).toHaveTextContent('NODE_ENV=')
      expect(container).toHaveTextContent('scripts/')
      expect(container).toHaveTextContent('package.json')
      expect(container.querySelector('[data-native-chat-code-content]')).toHaveTextContent(
        'node --env-file=.env.development scripts/dev.mjs'
      )
    }
  )

  it.each([14, 17])(
    'renders the complete sample without reserved user metadata at %spx',
    (fontSize) => {
      vi.stubGlobal('api', undefined)
      const { container } = render(
        <NativeChatAppearancePreview
          settings={{ ...getDefaultSettings('/tmp'), nativeChatAppearance: { fontSize } }}
        />
      )

      expect(screen.getByText('Preview')).toBeInTheDocument()
      expect(screen.getByText(/exit right after it starts on Windows/)).toBeInTheDocument()
      expect(screen.getByText('Worked for 12s')).toBeInTheDocument()
      expect(container.querySelector('[data-native-chat-tool-run-state="settled"]')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Read package.json' })).toBeInTheDocument()
      expect(container.querySelector('[data-native-chat-code-content]')).toHaveTextContent(
        'node --env-file=.env.development scripts/dev.mjs'
      )
      expect(screen.getByText(/Then run/)).toHaveTextContent('Then run pnpm dev again.')
      expect(previewRoot(container)).toHaveClass('h-[440px]', 'overflow-hidden')
      expect(previewRoot(container)).toHaveClass(NATIVE_CHAT_APPEARANCE_ROOT_CLASS)
      const outer = previewRoot(container).firstElementChild
      expect(outer).toHaveClass(cn(NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS, 'py-3'))
      expect(outer?.firstElementChild).toHaveClass(cn(NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS, 'gap-2'))
      const userBubble = screen.getByText(/exit right after it starts on Windows/).closest('.group')
      expect(userBubble?.querySelector('time, button')).toBeNull()
      expect(userBubble?.children).toHaveLength(1)
      expect(screen.getByText('Worked for 12s').closest('button')).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      const code = container.querySelector('[data-native-chat-code-content]')
      const tools = container.querySelector('[data-native-chat-tool-run-state]')
      expect(tools).toHaveTextContent('Searched 1 pattern, read 1 file')
      expect(tools).toHaveAttribute('aria-expanded', 'true')
      expect(tools?.nextElementSibling?.querySelectorAll('button')).toHaveLength(2)
      const intro = screen.getByText('Unix-only').closest('p')
      expect(
        intro && tools && intro.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        code && tools && tools.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  )

  it('updates the shared chat styling when text size, code size and width change', () => {
    const settings = getDefaultSettings('/tmp')
    const { container, rerender } = render(<NativeChatAppearancePreview settings={settings} />)
    const root = previewRoot(container)
    expect(root.style.getPropertyValue('--chat-font-size')).toBe('14px')
    expect(root.style.getPropertyValue('--chat-code-font-size')).toBe('12px')
    expect(root.style.getPropertyValue('--chat-content-max-width')).toBe('46rem')

    rerender(
      <NativeChatAppearancePreview
        settings={{
          ...settings,
          nativeChatAppearance: { fontSize: 18, codeFontSize: 16, width: 'wide' }
        }}
      />
    )
    expect(root.style.getPropertyValue('--chat-font-size')).toBe('18px')
    expect(root.style.getPropertyValue('--chat-code-font-size')).toBe('16px')
    expect(root.style.getPropertyValue('--chat-content-max-width')).toBe('60rem')

    rerender(
      <NativeChatAppearancePreview
        settings={{ ...settings, nativeChatAppearance: { width: 'full' } }}
      />
    )
    expect(root.style.getPropertyValue('--chat-content-max-width')).toBe('none')
  })

  it('blocks sample controls without IPC or reads and writes to a surrounding session disclosure store', () => {
    const ipc = vi.fn(() => {
      throw new Error('The preview must not call IPC')
    })
    vi.stubGlobal('api', new Proxy({}, { get: ipc }))
    const { container } = render(
      <NativeChatDisclosureContext.Provider value={surroundingDisclosureStore}>
        <NativeChatAppearancePreview settings={getDefaultSettings('/tmp')} />
      </NativeChatDisclosureContext.Provider>
    )
    const root = previewRoot(container)
    expect(root).toHaveAttribute('inert')
    expect(root.querySelector('a')).toBeNull()
    for (const button of root.querySelectorAll('button')) {
      fireEvent.click(button)
      fireEvent.keyDown(button, { key: 'Enter' })
      fireEvent.contextMenu(button)
      fireEvent(button, new MouseEvent('auxclick', { bubbles: true }))
    }
    expect(root.querySelector('[data-native-chat-tool-run-state]')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(ipc).not.toHaveBeenCalled()
    expect(surroundingDisclosureStore.read).not.toHaveBeenCalled()
    expect(surroundingDisclosureStore.write).not.toHaveBeenCalled()
  })
})
