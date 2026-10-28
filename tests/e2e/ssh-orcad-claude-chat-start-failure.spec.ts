// A Claude chat on a managed SSH host whose CLI refuses to start says why, not only that it stopped.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { callEnvironment } from './helpers/paired-host-terminal'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const STUB = readFileSync(
  path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'structured-claude-stub.cjs')
)
const ROOT_REFUSAL =
  '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons'

// The Docker host's SSH user is root, and Claude Code refuses Full access as root this way.
const WRAPPER = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--dangerously-skip-permissions" ] && [ "$(id -u)" = 0 ]; then
    echo "${ROOT_REFUSAL}" >&2
    exit 1
  fi
done
exec /usr/local/bin/node /usr/local/lib/orca-e2e-claude-stub.cjs /tmp/orca-e2e-claude-launches.jsonl "$@"
`

test('a Claude chat that Claude refuses to start as root names the reason', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  // Converting the Docker host to a managed server takes minutes before the chat opens.
  test.setTimeout(10 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const exec = fixture.host.exec
    if (!exec) {
      throw new Error('the Docker host runs commands as its SSH user')
    }
    exec(
      `echo ${STUB.toString('base64')} | base64 -d > /usr/local/lib/orca-e2e-claude-stub.cjs && ` +
        `echo ${Buffer.from(WRAPPER).toString('base64')} | base64 -d > /usr/local/bin/claude && ` +
        'chmod 755 /usr/local/bin/claude'
    )
    const { page, environmentId } = await launchManagedWorkspace(fixture)
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude'
      })
    })
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    await page.getByText('Claude', { exact: true }).first().click({ timeout: 60_000 })
    const chat = page.locator('[data-native-chat-root="true"]')
    await expect(chat).toBeVisible({ timeout: 60_000 })
    const composer = chat.getByRole('textbox')
    await composer.click()
    await page.keyboard.type('hello')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(chat).toContainText("Claude won't use Full access while it runs as root.", {
      timeout: 120_000
    })
    // Claude's own words sit behind Details on the start-failure row.
    await chat.getByText('Details', { exact: true }).first().click()
    await expect(chat).toContainText(ROOT_REFUSAL)
    await page.screenshot({ path: testInfo.outputPath('claude-root-start-failure.png') })

    // The sentence's next step works: with another permission on that host, a new chat starts Claude.
    await callEnvironment(page, environmentId, 'settings.mutateAgentLaunch', {
      type: 'permission',
      choice: 'ask',
      agent: 'claude'
    })
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    await page.getByText('Claude', { exact: true }).first().click({ timeout: 60_000 })
    const next = page.locator('[data-native-chat-root="true"]').last()
    await next.getByRole('textbox').click()
    await page.keyboard.type('again')
    await next.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(next.getByText('Stub reply.')).toBeVisible({ timeout: 120_000 })
  })
})
