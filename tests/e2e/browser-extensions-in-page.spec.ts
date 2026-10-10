/**
 * What a password manager like 1Password does inside a page, end to end in Orca's browser: an
 * inline menu in an extension iframe that fills the page, passkey requests answered by the
 * extension, content scripts in cross-site frames, context-menu entries, and shortcuts.
 */
import { test, expect } from './helpers/orca-app'
import {
  dispatchGuestInput,
  evalInPage,
  openPageWithExtension,
  startHtmlServer,
  writeTestExtension
} from './helpers/browser-extension-fixture'

const WORKER = `
chrome.contextMenus.create({ id: 'fill', title: 'Fill with probe', contexts: ['editable'] })
const fill = (tabId, frameId, value) => chrome.tabs.sendMessage(tabId, { fill: value }, { frameId })
chrome.contextMenus.onClicked.addListener((info, tab) => fill(tab.id, info.frameId, 'from-context-menu'))
chrome.commands.onCommand.addListener((_name, tab) => fill(tab.id, 0, 'from-shortcut'))
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'menu-pick') {
    fill(sender.tab.id, 0, 'from-inline-menu')
  } else if (message.type === 'passkey') {
    reply({ id: 'extension-passkey', origin: sender.origin })
  } else if (message.type === 'hello') {
    reply({ tab: sender.tab?.id !== undefined, frameId: sender.frameId })
  }
})
`

// Isolated world, every frame: the inline menu iframe, the fill, and the passkey relay.
const CONTENT = `
if (window === top) {
  const frame = document.createElement('iframe')
  frame.src = chrome.runtime.getURL('menu.html')
  frame.style = 'position:fixed;left:0;top:0;width:200px;height:100px;border:0'
  const host = document.createElement('probe-inline-menu')
  host.attachShadow({ mode: 'closed' }).append(frame)
  document.documentElement.append(host)
}
chrome.runtime.sendMessage({ type: 'hello' }, (answer) => {
  document.documentElement.dataset.hello = JSON.stringify(answer)
})
chrome.runtime.onMessage.addListener((message) => {
  document.getElementById('user').value = message.fill
})
window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.type === 'passkey-request') {
    chrome.runtime.sendMessage({ type: 'passkey' }, (credential) =>
      window.postMessage({ type: 'passkey-response', credential }, '*'))
  }
})
`

// Main world, as 1Password wraps WebAuthn: the page's own navigator.credentials.
const MAIN = `
navigator.credentials.get = () => new Promise((resolve) => {
  addEventListener('message', function onResponse(event) {
    if (event.data?.type === 'passkey-response') {
      removeEventListener('message', onResponse)
      resolve(event.data.credential)
    }
  })
  postMessage({ type: 'passkey-request' }, '*')
})
`

const MENU_HTML = `<!doctype html><body style="margin:0">
<button style="width:200px;height:100px">Fill</button><script src="menu.js"></script>`
const MENU_JS = `document.querySelector('button').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'menu-pick' })
})`

const SHORTCUT_MODIFIERS: Electron.InputEvent['modifiers'] = [
  process.platform === 'darwin' ? 'meta' : 'control',
  'shift'
]

test('a password-manager style extension works inside pages', async ({ orcaPage, electronApp }) => {
  const server = await startHtmlServer((request, port) =>
    request.url === '/frame'
      ? '<!doctype html><title>frame</title><input id="user">'
      : `<!doctype html><title>Login</title><div style="height:120px"></div>
<input id="user" style="width:300px"><iframe src="http://127.0.0.1:${port}/frame"></iframe>`
  )
  const hosts = ['http://localhost/*', 'http://127.0.0.1/*']
  const extensionDir = writeTestExtension(
    {
      name: 'Orca in-page probe',
      permissions: ['contextMenus', 'tabs'],
      background: { service_worker: 'worker.js' },
      commands: {
        fill: {
          suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
          description: 'Fill'
        }
      },
      content_scripts: [
        { matches: hosts, js: ['content.js'], all_frames: true },
        {
          matches: hosts,
          js: ['main.js'],
          world: 'MAIN',
          all_frames: true,
          run_at: 'document_start'
        }
      ],
      web_accessible_resources: [{ resources: ['menu.html', 'menu.js'], matches: ['<all_urls>'] }]
    },
    {
      'worker.js': WORKER,
      'content.js': CONTENT,
      'main.js': MAIN,
      'menu.html': MENU_HTML,
      'menu.js': MENU_JS
    }
  )
  try {
    // A different host from the cross-site frame, so that frame is out of process.
    const { pageId, guestId } = await openPageWithExtension(
      orcaPage,
      electronApp,
      `http://localhost:${server.port}/`,
      'Login',
      extensionDir
    )
    const userValue = (): Promise<unknown> =>
      evalInPage(orcaPage, pageId, 'document.getElementById("user").value')
    const click = (x: number, y: number, button: 'left' | 'right') =>
      dispatchGuestInput(electronApp, guestId, [
        {
          method: 'Input.dispatchMouseEvent',
          params: { type: 'mousePressed', x, y, button, clickCount: 1 }
        },
        {
          method: 'Input.dispatchMouseEvent',
          params: { type: 'mouseReleased', x, y, button, clickCount: 1 }
        }
      ])

    await test.step('content scripts know their tab, in the page and in a cross-site frame', async () => {
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'document.documentElement.dataset.hello ?? null'))
        .toBe(JSON.stringify({ tab: true, frameId: 0 }))
      await expect
        .poll(() =>
          electronApp.evaluate(async ({ webContents }, id) => {
            const frame = webContents
              .fromId(id)
              ?.mainFrame.framesInSubtree.find((f) => f.url.endsWith('/frame'))
            return frame
              ? frame.executeJavaScript('document.documentElement.dataset.hello ?? null')
              : null
          }, guestId)
        )
        .toMatch(/"tab":true/)
    })

    await test.step('a click in the extension iframe fills the page', async () => {
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, id) =>
              webContents
                .fromId(id)
                ?.mainFrame.framesInSubtree.some((f) => f.url.endsWith('/menu.html')) ?? false,
            guestId
          )
        )
        .toBe(true)
      // Why retry: the frame exists before it paints, and a click before then hits nothing.
      await expect
        .poll(async () => {
          await click(100, 50, 'left')
          return userValue()
        })
        .toBe('from-inline-menu')
    })

    await test.step("the extension answers the page's passkey request", async () => {
      const credential = await evalInPage(
        orcaPage,
        pageId,
        'navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } }).then(JSON.stringify)'
      )
      expect(credential).toBe(
        JSON.stringify({ id: 'extension-passkey', origin: `http://localhost:${server.port}` })
      )
    })

    await test.step("the extension's context-menu entry fills the right-clicked frame", async () => {
      const rightClickFill = async (inputCenter: string): Promise<void> => {
        const point = JSON.parse(String(await evalInPage(orcaPage, pageId, inputCenter)))
        await click(Math.round(point.x), Math.round(point.y), 'right')
        const menu = orcaPage.getByTestId('browser-context-menu')
        await menu.getByRole('menuitem', { name: 'Fill with probe' }).click()
      }
      await rightClickFill(`(() => {
        const r = document.getElementById('user').getBoundingClientRect()
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
      })()`)
      await expect.poll(userValue).toBe('from-context-menu')

      // The cross-site frame's input sits near its top-left corner.
      await rightClickFill(`(() => {
        const r = document.querySelector('iframe').getBoundingClientRect()
        return JSON.stringify({ x: r.x + 20, y: r.y + 15 })
      })()`)
      await expect
        .poll(() =>
          electronApp.evaluate(async ({ webContents }, id) => {
            const frame = webContents
              .fromId(id)
              ?.mainFrame.framesInSubtree.find((f) => f.url.endsWith('/frame'))
            return frame?.executeJavaScript('document.getElementById("user").value') ?? null
          }, guestId)
        )
        .toBe('from-context-menu')
    })

    await test.step("the extension's shortcut reaches its worker", async () => {
      // Why the webview's own input: DevTools key events skip before-input-event, where shortcuts run.
      await orcaPage.evaluate(
        async ({ id, modifiers }) => {
          const webview = [...document.querySelectorAll<Electron.WebviewTag>('webview')].find(
            (candidate) => candidate.getWebContentsId() === id
          )
          if (!webview) {
            throw new Error('page webview not found')
          }
          webview.focus()
          await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Y', modifiers })
          await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Y', modifiers })
        },
        { id: guestId, modifiers: SHORTCUT_MODIFIERS }
      )
      await expect.poll(userValue).toBe('from-shortcut')
    })
  } finally {
    await server.close()
  }
})
