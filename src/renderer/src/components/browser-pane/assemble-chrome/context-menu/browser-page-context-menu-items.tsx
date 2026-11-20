import { Fragment } from 'react'
import { useAppStore } from '@/store/index'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../../../shared/browser/navigation/browser-url'
import type { BrowserPageContextMenuState } from '../../describe-page/browser-page-types'
import { BrowserPageExtensionMenuItems } from '../extensions/browser-page-extension-menu-items'

// Programmatic menu focus represents keyboard navigation, so use focus rather than focus-visible.
const MENU_ITEM_CLASS =
  'relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 focus:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14 dark:focus:bg-white/14'

const SEARCH_LABEL_MAX_CHARS = 32

type MenuItem = { label: string; disabled?: boolean; run: () => void }

export type BrowserPageEditCommand =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'selectAll'

/** What the menu's items do, for a page in this window's webview or one streamed from a host. */
export type BrowserPageContextMenuActions = {
  edit: (command: BrowserPageEditCommand) => void
  /** Left out where the page's spell checker is not on this machine. */
  replaceMisspelling?: (word: string) => void
  addWordToDictionary?: (word: string) => void
  openInNewTab: (url: string, activate: boolean) => void
  /** The address the OS browser should open, or null to leave the item out. */
  externalUrl: (url: string) => string | null
  /** Left out where the page's downloads, pixels or DevTools are not on this machine. */
  saveImage?: (url: string) => void
  copyImage?: () => void
  inspect?: () => void
  goBack: () => void
  goForward: () => void
  reload: () => void
}

function searchLabelText(selection: string): string {
  const collapsed = selection.replace(/\s+/g, ' ').trim()
  return collapsed.length > SEARCH_LABEL_MAX_CHARS
    ? `${collapsed.slice(0, SEARCH_LABEL_MAX_CHARS - 1)}…`
    : collapsed
}

type BrowserPageContextMenuItemsProps = {
  menu: BrowserPageContextMenuState
  canGoBack: boolean
  canGoForward: boolean
  actions: BrowserPageContextMenuActions
  onClose: () => void
}

/** Specific editable/link/image/selection sections replace generic page navigation. */
function buildMenuSections(
  {
    menu,
    canGoBack,
    canGoForward,
    actions,
    onClose,
    searchEngine
  }: BrowserPageContextMenuItemsProps & { searchEngine: SearchEngine },
  t: Translate = translate
): MenuItem[][] {
  const { editable, image, linkUrl, pageUrl } = menu
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
  const editItem = (
    label: string,
    command: BrowserPageEditCommand,
    enabled: boolean
  ): MenuItem => ({
    label,
    disabled: !enabled,
    run: () => {
      onClose()
      actions.edit(command)
    }
  })
  const externalItem = (label: string, url: string): MenuItem[] => {
    const targetUrl = actions.externalUrl(url)
    return targetUrl ? [item(label, () => void window.api.shell.openUrl(targetUrl))] : []
  }
  const { replaceMisspelling, addWordToDictionary, saveImage, copyImage, inspect } = actions

  const sections: MenuItem[][] = []
  if (editable) {
    const { suggestions, misspelledWord } = editable.spelling
    sections.push([
      ...(replaceMisspelling
        ? suggestions.map((word) => item(word, () => replaceMisspelling(word)))
        : []),
      ...(misspelledWord && addWordToDictionary
        ? [
            item(
              t('auto.components.browser.pane.BrowserPane.addToDictionary', 'Add to Dictionary'),
              () => addWordToDictionary(misspelledWord)
            )
          ]
        : [])
    ])
    sections.push([
      editItem(
        t('auto.components.browser.pane.BrowserPane.undo', 'Undo'),
        'undo',
        editable.canUndo
      ),
      editItem(t('auto.components.browser.pane.BrowserPane.redo', 'Redo'), 'redo', editable.canRedo)
    ])
    sections.push([
      editItem(t('auto.components.browser.pane.BrowserPane.cut', 'Cut'), 'cut', editable.canCut),
      editItem(
        t('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy'),
        'copy',
        editable.canCopy
      ),
      editItem(
        t('auto.components.browser.pane.BrowserPane.paste', 'Paste'),
        'paste',
        editable.canPaste
      ),
      editItem(
        isMac
          ? t(
              'auto.components.browser.pane.BrowserPane.pasteAndMatchStyle',
              'Paste and Match Style'
            )
          : t('auto.components.browser.pane.BrowserPane.pasteAsPlainText', 'Paste as Plain Text'),
        'pasteAndMatchStyle',
        editable.canPaste
      ),
      editItem(
        t('auto.components.browser.pane.BrowserPane.selectAll', 'Select All'),
        'selectAll',
        editable.canSelectAll
      )
    ])
  }
  if (linkUrl) {
    sections.push([
      item(
        t('auto.components.browser.pane.BrowserPane.b5b87d6cbb', 'Open Link In Orca Browser'),
        () => actions.openInNewTab(linkUrl, false)
      ),
      ...externalItem(
        t('auto.components.browser.pane.BrowserPane.8ce4f6b12e', 'Open Link In Default Browser'),
        linkUrl
      ),
      item(
        t('auto.components.browser.pane.BrowserPane.efb0e8f7f3', 'Copy Link Address'),
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
              t(
                'auto.components.browser.pane.BrowserPane.openImageInNewTab',
                'Open Image in New Tab'
              ),
              () => actions.openInNewTab(openableImageUrl, false)
            )
          ]
        : []),
      ...(saveImage
        ? [
            item(t('auto.components.browser.pane.BrowserPane.saveImage', 'Save Image'), () =>
              saveImage(image.url)
            )
          ]
        : []),
      ...(copyImage
        ? [
            item(
              t('auto.components.browser.pane.BrowserPane.copyImage', 'Copy Image'),
              copyImage,
              !image.canCopy
            )
          ]
        : []),
      item(
        t('auto.components.browser.pane.BrowserPane.copyImageAddress', 'Copy Image Address'),
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
              t('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy'),
              () => void window.api.ui.writeClipboardText(selectionText)
            )
          ]),
      item(
        t(
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
          actions.openInNewTab(url, true)
        }
      )
    ])
  }
  if (!editable && !linkUrl && !image && !selectionText) {
    sections.push([
      item(
        t('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back'),
        actions.goBack,
        !canGoBack
      ),
      item(
        t('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward'),
        actions.goForward,
        !canGoForward
      ),
      item(t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload'), actions.reload)
    ])
    sections.push([
      ...externalItem(
        t('auto.components.browser.pane.BrowserPane.f7ab83f7ed', 'Open Page In Default Browser'),
        pageUrl
      ),
      item(
        t('auto.components.browser.pane.BrowserPane.1b179ab561', 'Copy Page URL'),
        () => void window.api.ui.writeClipboardText(pageUrl)
      )
    ])
  }
  if (inspect) {
    sections.push([item(t('auto.components.browser.pane.BrowserPane.inspect', 'Inspect'), inspect)])
  }

  return sections.filter((section) => section.length > 0)
}

export function BrowserPageContextMenuItems(
  props: BrowserPageContextMenuItemsProps
): React.JSX.Element {
  const t = useTranslate()
  const searchEngine = useAppStore((s) => s.browserDefaultSearchEngine) ?? DEFAULT_SEARCH_ENGINE
  const sections = buildMenuSections({ ...props, searchEngine }, t)
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
