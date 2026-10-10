/**
 * Chrome extensions in Orca's browser: an extension's service worker gets the chrome.* APIs
 * Electron lacks, under both `chrome` and `browser`, its content scripts reach it, and its
 * toolbar button shows beside the page with its badge and opens its popup.
 */
import { test, expect } from './helpers/orca-app'
import {
  evalInPage,
  openPageWithExtension,
  startHtmlServer,
  writeTestExtension
} from './helpers/browser-extension-fixture'

// Why `browser` and module type: 1Password's worker is a module and uses the `browser` namespace.
const SERVICE_WORKER = `
browser.runtime.onMessage.addListener((_message, sender, reply) => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) =>
    reply({
      windows: typeof browser.windows?.getAll,
      contextMenus: typeof browser.contextMenus?.create,
      sameNamespace: browser === chrome,
      activeTabIsSender: tabs.length === 1 && tabs[0].id === sender.tab?.id
    })
  )
  browser.action.setBadgeText({ text: '7' })
  return true
})
`

const CONTENT_SCRIPT = `
chrome.runtime.sendMessage({}, (answer) => {
  document.documentElement.dataset.extension = JSON.stringify(answer)
})
`

test('an installed extension runs with the full chrome API and shows a toolbar button', async ({
  orcaPage,
  electronApp
}) => {
  const server = await startHtmlServer(() => '<!doctype html><title>Extension probe</title>')
  try {
    const extensionDir = writeTestExtension(
      {
        name: 'Orca e2e extension',
        permissions: ['contextMenus', 'tabs'],
        background: { service_worker: 'worker.js', type: 'module' },
        action: { default_title: 'Orca e2e extension', default_popup: 'popup.html' },
        content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }]
      },
      {
        'worker.js': SERVICE_WORKER,
        'content.js': CONTENT_SCRIPT,
        'popup.html':
          '<!doctype html><title>popup</title><body style="margin:0;width:240px;height:120px">'
      }
    )
    const { pageId } = await openPageWithExtension(
      orcaPage,
      electronApp,
      `http://127.0.0.1:${server.port}/`,
      'Extension probe',
      extensionDir
    )

    await expect
      .poll(() =>
        evalInPage(orcaPage, pageId, 'document.documentElement.dataset.extension ?? null')
      )
      .toBe(
        JSON.stringify({
          windows: 'function',
          contextMenus: 'function',
          sameNamespace: true,
          activeTabIsSender: true
        })
      )
    const button = orcaPage.locator('[data-testid="browser-extension-actions"] button').first()
    await expect(button).toHaveAttribute('title', 'Orca e2e extension')
    await expect(button).toHaveText('7')

    // Clicking the button opens the extension's popup in its own window, sized to its page.
    await button.click()
    await expect
      .poll(() =>
        electronApp.evaluate(({ webContents, BrowserWindow }) => {
          const popup = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL().endsWith('/popup.html'))
          const bounds = popup && BrowserWindow.fromWebContents(popup)?.getBounds()
          return bounds ? [bounds.width, bounds.height] : null
        })
      )
      .toEqual([240, 120])
  } finally {
    await server.close()
  }
})
