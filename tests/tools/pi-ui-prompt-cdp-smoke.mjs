// Run against an isolated Orca dev instance with Pi and pi-ui-prompt-extension.mjs loaded.
// Usage: node tests/tools/pi-ui-prompt-cdp-smoke.mjs http://127.0.0.1:9333 /path/to/proof
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, expect } from '@stablyai/playwright-test'

const [endpoint, outputDirectory] = process.argv.slice(2)
assert.ok(endpoint && outputDirectory, 'Pass the CDP endpoint and screenshot directory')
const output = resolve(outputDirectory)
await mkdir(output, { recursive: true })
const browser = await chromium.connectOverCDP(endpoint)
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0]
  assert.ok(page, 'Orca renderer must be open')
  const identity = await page.evaluate(() => window.api.app.getIdentity())
  assert.equal(identity.isDev, true, 'Use an isolated development instance')
  console.log(JSON.stringify(identity))
  const terminals = page.locator('[data-pty-id]')
  await expect(terminals).toHaveCount(1)
  const terminal = terminals.first()
  const input = page.getByRole('textbox', { name: 'Terminal input' })
  const attention = page.getByLabel('Needs attention', { exact: true })
  const waitForState = (state) =>
    expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(window.__store.getState().agentStatusByPaneKey)
            .filter((entry) => entry.agentType === 'pi')
            .map((entry) => entry.state)
        )
      )
      .toEqual([state])

  for (const kind of ['select', 'confirm', 'input', 'editor', 'custom']) {
    for (const ending of kind === 'select' ? ['answer', 'cancel'] : ['cancel']) {
      await input.pressSequentially(`/orca-modal ${kind}`, { delay: 10 })
      await input.press('Enter')
      await waitForState('waiting')
      await expect(attention).toBeVisible()
      await expect(terminal).toBeVisible()
      await page.screenshot({ path: join(output, `${kind}-${ending}-waiting.png`) })
      await (kind === 'custom'
        ? page.evaluate(() => {
            const id = document.querySelector('[data-pty-id]')?.getAttribute('data-pty-id')
            if (!id) {
              throw new Error('Terminal lost its PTY')
            }
            window.api.pty.write(id, '\u001b')
          })
        : input.press(ending === 'answer' ? 'Enter' : 'Escape'))
      await waitForState('done')
      await expect(attention).toHaveCount(0)
      await expect(page.getByLabel('Done', { exact: true })).toBeVisible()
      await page.screenshot({ path: join(output, `${kind}-${ending}-done.png`) })
      console.log(`PASS: ${kind}/${ending}: waiting -> done, visible icon agrees`)
    }
  }
} finally {
  await browser.close()
}
