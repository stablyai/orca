import { Fragment, type MutableRefObject } from 'react'
import { useAppStore } from '@/store'
import { isMac } from '@/app-shell/app-window-chrome'
import { translate } from '@/i18n/i18n'
import { openUrlInTabBesideBrowserPage } from '@/lib/browser-page-tab-opening'
import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../../shared/browser-url'
import type { BrowserPageContextMenuState } from '../describe-page/browser-page-types'
import { BrowserPageExtensionMenuItems } from './browser-page-extension-menu-items'

// Programmatic menu focus represents keyboard navigation, so use focus rather than focus-visible.
const MENU_ITEM_CLASS =
  'relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 focus:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14 dark:focus:bg-white/14'

const SEARCH_LABEL_MAX_CHARS = 32

type MenuItem = { label: string; disabled?: boolean; run: () => void }

type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll'

function searchLabelText(selection: string): string {
  const collapsed = selection.replace(/\s+/g, ' ').trim()
  return collapsed.length > SEARCH_LABEL_MAX_CHARS
    ? `${collapsed.slice(0, SEARCH_LABEL_MAX_CHARS - 1)}…`
    : collapsed
}

type BrowserPageContextMenuItemsProps = {
  menu: BrowserPageContextMenuState
  browserPageId: string
  worktreeId: string
  canGoBack: boolean
  canGoForward: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  onReload: () => void
  onClose: () => void
}

/** Specific editable/link/image/selection sections replace generic page navigation. */
function buildMenuSections({
  menu,
  browserPageId,
  worktreeId,
  canGoBack,
  canGoForward,
  webviewRef,
  onReload,
  onClose,
  searchEngine
}: BrowserPageContextMenuItemsProps & { searchEngine: SearchEngine }): MenuItem[][] {
  const { editable, image, linkUrl, pageUrl, pagePoint } = menu
  const selectionText = menu.selectionText.trim() ? menu.selectionText : ''

  const item = (label: string, run: () => void, disabled = false): MenuItem => ({
    label,
    disabled,
    run: () => {
      run()
      onClose()
    }
  })
  // Why close first: closing hands focus back to the guest, which edit commands act on.
  const editItem = (label: string, command: EditCommand, enabled: boolean): MenuItem => ({
    label,
    disabled: !enabled,
    run: () => {
      onClose()
      webviewRef.current?.[command]()
    }
  })
  const openInNewTab = (url: string, activate: boolean): void => {
    openUrlInTabBesideBrowserPage({ sourcePageId: browserPageId, worktreeId, url, activate })
  }
  const openExternally = (url: string): void => {
    const targetUrl = normalizeExternalBrowserUrl(url)
    if (targetUrl) {
      void window.api.shell.openUrl(targetUrl)
    }
  }

  const sections: MenuItem[][] = []
  if (editable) {
    const { suggestions, misspelledWord } = editable.spelling
    sections.push([
      ...suggestions.map((word) => item(word, () => webviewRef.current?.replaceMisspelling(word))),
      ...(misspelledWord
        ? [
            item(
              translate(
                'auto.components.browser.pane.BrowserPane.addToDictionary',
                'Add to Dictionary'
              ),
              () =>
                void window.api.browser.addWordToDictionary({ browserPageId, word: misspelledWord })
            )
          ]
        : [])
    ])
    sections.push([
      editItem(
        translate('auto.components.browser.pane.BrowserPane.undo', 'Undo'),
        'undo',
        editable.canUndo
      ),
      editItem(
        translate('auto.components.browser.pane.BrowserPane.redo', 'Redo'),
        'redo',
        editable.canRedo
      )
    ])
    sections.push([
      editItem(
        translate('auto.components.browser.pane.BrowserPane.cut', 'Cut'),
        'cut',
        editable.canCut
      ),
      editItem(
        translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy'),
        'copy',
        editable.canCopy
      ),
      editItem(
        translate('auto.components.browser.pane.BrowserPane.paste', 'Paste'),
        'paste',
        editable.canPaste
      ),
      editItem(
        isMac
          ? translate(
              'auto.components.browser.pane.BrowserPane.pasteAndMatchStyle',
              'Paste and Match Style'
            )
          : translate(
              'auto.components.browser.pane.BrowserPane.pasteAsPlainText',
              'Paste as Plain Text'
            ),
        'pasteAndMatchStyle',
        editable.canPaste
      ),
      editItem(
        translate('auto.components.browser.pane.BrowserPane.selectAll', 'Select All'),
        'selectAll',
        editable.canSelectAll
      )
    ])
  }
  if (linkUrl) {
    sections.push([
      item(
        translate(
          'auto.components.browser.pane.BrowserPane.b5b87d6cbb',
          'Open Link In Orca Browser'
        ),
        () => openInNewTab(linkUrl, false)
      ),
      item(
        translate(
          'auto.components.browser.pane.BrowserPane.8ce4f6b12e',
          'Open Link In Default Browser'
        ),
        () => openExternally(linkUrl)
      ),
      item(
        translate('auto.components.browser.pane.BrowserPane.efb0e8f7f3', 'Copy Link Address'),
        () => void window.api.ui.writeClipboardText(linkUrl)
      )
    ])
  }
  if (image) {
    // Why: data: and blob: images can't be loaded as a tab of their own, so only Open needs a navigable URL.
    const openableImageUrl = normalizeBrowserNavigationUrl(image.url)
    sections.push([
      ...(openableImageUrl
        ? [
            item(
              translate(
                'auto.components.browser.pane.BrowserPane.openImageInNewTab',
                'Open Image in New Tab'
              ),
              () => openInNewTab(openableImageUrl, false)
            )
          ]
        : []),
      // Use guest download rules for local Downloads or the client-hosted remote workspace.
      item(translate('auto.components.browser.pane.BrowserPane.saveImage', 'Save Image'), () =>
        webviewRef.current?.downloadURL(image.url)
      ),
      item(
        translate('auto.components.browser.pane.BrowserPane.copyImage', 'Copy Image'),
        () => void window.api.browser.copyImageAt({ browserPageId, point: pagePoint }),
        !image.canCopy
      ),
      item(
        translate(
          'auto.components.browser.pane.BrowserPane.copyImageAddress',
          'Copy Image Address'
        ),
        () => void window.api.ui.writeClipboardText(image.url)
      )
    ])
  }
  if (selectionText) {
    sections.push([
      // Why: an editable field's Copy is already in its edit section.
      ...(editable
        ? []
        : [
            // Why: copy the native selection directly, bypassing pages that suppress copy via oncopy handlers.
            item(
              translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy'),
              () => void window.api.ui.writeClipboardText(selectionText)
            )
          ]),
      item(
        translate(
          'auto.components.browser.pane.BrowserPane.searchSelection',
          'Search {{value0}} for “{{value1}}”',
          {
            value0: SEARCH_ENGINE_LABELS[searchEngine],
            value1: searchLabelText(selectionText)
          }
        ),
        () => {
          const { browserKagiSessionLink } = useAppStore.getState()
          const url = buildSearchUrl(selectionText.trim(), searchEngine, {
            kagiSessionLink: browserKagiSessionLink
          })
          openInNewTab(url, true)
        }
      )
    ])
  }
  if (!editable && !linkUrl && !image && !selectionText) {
    sections.push([
      item(
        translate('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back'),
        () => webviewRef.current?.goBack(),
        !canGoBack
      ),
      item(
        translate('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward'),
        () => webviewRef.current?.goForward(),
        !canGoForward
      ),
      item(translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload'), onReload)
    ])
    sections.push([
      item(
        translate(
          'auto.components.browser.pane.BrowserPane.f7ab83f7ed',
          'Open Page In Default Browser'
        ),
        () => openExternally(pageUrl)
      ),
      item(
        translate('auto.components.browser.pane.BrowserPane.1b179ab561', 'Copy Page URL'),
        () => void window.api.ui.writeClipboardText(pageUrl)
      )
    ])
  }
  sections.push([
    item(
      translate('auto.components.browser.pane.BrowserPane.inspect', 'Inspect'),
      () => void window.api.browser.openDevTools({ browserPageId, inspectAt: pagePoint })
    )
  ])

  return sections.filter((section) => section.length > 0)
}

export function BrowserPageContextMenuItems(
  props: BrowserPageContextMenuItemsProps
): React.JSX.Element {
  const searchEngine = useAppStore((s) => s.browserDefaultSearchEngine) ?? DEFAULT_SEARCH_ENGINE
  const sections = buildMenuSections({ ...props, searchEngine })
  const { extensionMenu } = props.menu
  return (
    <>
      {sections.map((section, sectionIndex) => (
        <Fragment key={sectionIndex}>
          {sectionIndex > 0 ? <hr className="my-1 h-px border-0 bg-border/70" /> : null}
          {/* Why here: Chrome lists extension items last, just above Inspect. */}
          {extensionMenu && sectionIndex === sections.length - 1 ? (
            <>
              <BrowserPageExtensionMenuItems
                // Why keyed: each right-click starts with every submenu closed.
                key={extensionMenu.token}
                menu={extensionMenu}
                itemClassName={MENU_ITEM_CLASS}
                onDone={props.onClose}
              />
              <hr className="my-1 h-px border-0 bg-border/70" />
            </>
          ) : null}
          {section.map((menuItem, itemIndex) => (
            <button
              key={itemIndex}
              role="menuitem"
              disabled={menuItem.disabled}
              className={MENU_ITEM_CLASS}
              onClick={menuItem.run}
            >
              {menuItem.label}
            </button>
          ))}
        </Fragment>
      ))}
    </>
  )
}
