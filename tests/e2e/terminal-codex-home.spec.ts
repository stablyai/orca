import { test, expect } from './helpers/mcode-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  mcodeCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)
  })

  test('terminal process receives the MCode-managed Codex home', async ({ mcodePage }) => {
    await waitForActiveTerminalManager(mcodePage)
    const ptyId = await waitForActivePanePtyId(mcodePage)
    const marker = `__MCODE_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, mcodeCodexHome: process.env.MCODE_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(mcodePage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(mcodePage), marker)
          return Boolean(
            probe?.codexHome &&
            probe.mcodeCodexHome &&
            probe.codexHome === probe.mcodeCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose MCode-managed Codex home env' }
      )
      .toBe(true)

    expect(probe?.codexHome).toBe(probe?.mcodeCodexHome)
  })
})
