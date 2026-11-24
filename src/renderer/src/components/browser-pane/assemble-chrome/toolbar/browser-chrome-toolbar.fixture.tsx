import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import BrowserAddressBar from '../address-bar/BrowserAddressBar'
import { DocPreviewOverflowMenu } from '../../workspace-doc/doc-preview-overflow-menu'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'
import type { GrabIntent } from '../../../../../../shared/browser/element-grab/browser-grab-types'

const noop = (): void => {}

function Toolbar({
  annotationCount = 0,
  activeIntent = null,
  drawing = false
}: {
  annotationCount?: number
  activeIntent?: GrabIntent | null
  drawing?: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <BrowserChromeToolbar
      closeTabOwner={{ worktreeId: 'fixture', browserPageId: 'fixture-page' }}
      controls={{
        canGoBack: true,
        canGoForward: false,
        goBack: noop,
        goForward: noop,
        reload: noop,
        navigate: noop
      }}
      addressSlot={
        <BrowserAddressBar
          pageId="fixture-page"
          value="localhost:5173/settings"
          inputRef={inputRef}
          onChange={noop}
          onSubmit={noop}
          onNavigate={noop}
        />
      }
      elementTools={{
        activeIntent,
        onStartIntent: noop,
        disabled: false,
        grabShortcutLabel: '⌘C',
        annotateShortcutLabel: '⇧⌘C',
        annotationCount
      }}
      markup={{ active: drawing, disabled: false, onToggle: noop, canShowDiscoveryHint: false }}
      notes={{ onCopyAll: noop, onClear: noop }}
      overflowMenu={(overflow) => (
        <DocPreviewOverflowMenu
          onReload={noop}
          onHardReload={noop}
          onOpenSource={noop}
          onOpenExternally={noop}
          onCopyPath={noop}
          onCopyRelativePath={noop}
          overflow={overflow}
        />
      )}
    />
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

export const idle = defineFixture({ width: 640, render: () => <Toolbar /> })

export const withNotes = defineFixture({
  width: 640,
  render: () => <Toolbar annotationCount={3} />
})

export const annotating = defineFixture({
  width: 640,
  render: () => <Toolbar annotationCount={3} activeIntent="annotate" />
})

export const drawing = defineFixture({ width: 640, render: () => <Toolbar drawing /> })

export const addressFocused = defineFixture({
  width: 640,
  render: () => <Toolbar annotationCount={3} />,
  interact: async (frame) => {
    frame.querySelector<HTMLInputElement>('[data-orca-browser-address-bar="true"]')?.focus()
    await settle()
  }
})

export const annotateMenu = defineFixture({
  width: 640,
  render: () => <Toolbar annotationCount={3} />,
  interact: async (frame) => {
    frame
      .querySelector('button[aria-label="Annotate page element"]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
  }
})

export const overflowMenu = defineFixture({
  width: 640,
  render: () => <Toolbar annotationCount={3} />,
  interact: async (frame) => {
    frame.querySelector('button[aria-label="Preview options"]')?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await settle()
  }
})
