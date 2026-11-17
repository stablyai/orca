/**
 * Agent browser input must reach its page without touching the user's keyboard focus (#20595).
 * Runs hidden; browser-agent-input-focus-isolation-native.spec.ts repeats it in a visible window.
 */

import { test, expect } from './helpers/orca-app'
import {
  evalInPage,
  openBackgroundProbeTab,
  readProperty,
  rpc,
  runAgentClicksScenario,
  runAgentCrossSiteFrameScenario,
  runAgentKeysScenario,
  runAgentShortcutsScenario,
  startProbeServer
} from './helpers/browser-agent-focus-scenarios'
import { runAgentClickDuringUserCompositionScenario } from './helpers/browser-agent-composition-scenario'
import { getActiveTabId } from './helpers/store'

test('page-bound input stays out of chat drafts across hidden tabs and stale targets', async ({
  orcaPage
}) => {
  const server = await startProbeServer()
  try {
    const first = await openBackgroundProbeTab(orcaPage, server.url)
    const second = await openBackgroundProbeTab(orcaPage, server.url)
    await orcaPage.evaluate(() => {
      const draft = document.createElement('textarea')
      draft.id = 'browser-target-chat-draft'
      draft.value = 'Unsent human draft'
      document.body.append(draft)
      draft.focus()
    })
    const draft = orcaPage.locator('#browser-target-chat-draft')
    await rpc(orcaPage, 'browser.click', { page: first, element: '#notes' })
    await draft.focus()
    await rpc(orcaPage, 'browser.tabSwitch', { page: second })
    await evalInPage(orcaPage, second, 'document.getElementById("notes").focus()')

    await Promise.all([
      rpc(orcaPage, 'browser.keyboardInsertText', { page: first, text: 'First line\nSecond 🙏' }),
      rpc(orcaPage, 'browser.keyboardInsertText', { page: second, text: 'Other\ntab' }),
      draft.focus()
    ])
    await rpc(orcaPage, 'browser.type', { page: first, input: '!' })
    await rpc(orcaPage, 'browser.keypress', { page: second, key: 'End' })
    await rpc(orcaPage, 'browser.type', { page: second, input: '?' })
    expect(await evalInPage(orcaPage, first, 'document.getElementById("notes").value')).toBe(
      'First line\nSecond 🙏!'
    )
    expect(await evalInPage(orcaPage, second, 'document.getElementById("notes").value')).toBe(
      'Other\ntab?'
    )
    await expect(draft).toHaveValue('Unsent human draft')

    await rpc(orcaPage, 'browser.tabClose', { page: first })
    const terminalTab = await getActiveTabId(orcaPage)
    for (const command of [
      { method: 'browser.keyboardInsertText', params: { page: first, text: 'Stale insert' } },
      { method: 'browser.type', params: { page: 'missing-browser-page', input: 'Missing type' } },
      { method: 'browser.click', params: { page: terminalTab, element: 'textarea' } },
      { method: 'browser.keypress', params: { page: first, key: 'Enter' } }
    ]) {
      const response = await orcaPage.evaluate(
        (request) => window.api.runtime.call(request),
        command
      )
      expect(readProperty(response, 'ok')).toBe(false)
      expect(readProperty(readProperty(response, 'error'), 'code')).toBe('browser_tab_not_found')
    }
    await expect(draft).toHaveValue('Unsent human draft')
    expect(await evalInPage(orcaPage, second, 'document.getElementById("notes").value')).toBe(
      'Other\ntab?'
    )
  } finally {
    await server.close()
  }
})

test('text insertion needs a focused page target and never crashes or wedges the tab', async ({
  orcaPage
}) => {
  // Waits out a deliberately busy page (6 s) on top of tab startup and agent-browser round trips.
  test.setTimeout(120_000)
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(orcaPage, server.url)
    const insert = async (text: string): Promise<unknown> =>
      orcaPage.evaluate((request) => window.api.runtime.call(request), {
        method: 'browser.keyboardInsertText',
        params: { page: pageId, text }
      })
    const expectRefused = (response: unknown): void => {
      expect(readProperty(response, 'ok')).toBe(false)
      expect(JSON.stringify(readProperty(response, 'error'))).toContain('no focused element')
    }

    // A tab nobody focused has no frame to receive native text; Electron crashes if asked anyway.
    expectRefused(await insert('Fresh\ntab'))
    expect(await evalInPage(orcaPage, pageId, 'document.getElementById("notes").value')).toBe('')

    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'String(window.__frameReady)'))
      .toBe('true')
    await evalInPage(orcaPage, pageId, `document.getElementById('frame').focus()`)
    await rpc(orcaPage, 'browser.keypress', { page: pageId, key: 'Z' })
    await rpc(orcaPage, 'browser.keyboardInsertText', { page: pageId, text: 'Cross site 🙏' })
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'window.__frameValue'))
      .toBe('ZCross site 🙏')

    // A busy page cannot confirm where focus is; once it recovers, input must flow again.
    await evalInPage(
      orcaPage,
      pageId,
      'setTimeout(() => { const end = Date.now() + 6000; while (Date.now() < end) {} }, 0); "busy"'
    )
    expect(readProperty(await insert('Busy'), 'ok')).toBe(false)
    await expect
      .poll(() => evalInPage(orcaPage, pageId, '"responsive"'), { timeout: 20_000 })
      .toBe('responsive')
    await rpc(orcaPage, 'browser.keyboardInsertText', { page: pageId, text: ' ok' })
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'window.__frameValue'))
      .toBe('ZCross site 🙏 ok')
  } finally {
    await server.close()
  }
})

test('agent keys and text reach the page without leaving the user’s terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentKeysScenario(orcaPage)
})

test('agent clicks and presses reach the page without leaving the user’s terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentClicksScenario(orcaPage)
})

test('agent shortcut keys stay in the page instead of running Orca shortcuts', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentShortcutsScenario(orcaPage)
})

test('agent keys and text reach a focused cross-site frame without moving the user’s focus', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentCrossSiteFrameScenario(orcaPage)
})

test('an agent click is refused while the user composes with an IME in the terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentClickDuringUserCompositionScenario(orcaPage)
})
