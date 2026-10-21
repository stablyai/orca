/**
 * #26887 on the managed-server path: after the network to an orcad-managed SSH host drops and
 * comes back, a pane running an idle full-screen program shows the program's current frame. The
 * program changes its frame while the client is away and then goes quiet, the way an agent ends
 * its turn during a laptop sleep, so no later byte can heal the pane — only the reconnect can.
 */
import { expect, test } from './helpers/orca-app'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import {
  expectPaneText,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  typeInTerminal,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

// Redraws everything on SIGWINCH; otherwise only rewrites the frame text in place, like a spinner.
const TUI_SCRIPT = [
  'state=$1',
  'cur=$(cat "$state")',
  'draw() { printf \'\\033[?1049h\\033[H\\033[2JFRAME:%s\\r\\n\' "$cur"; }',
  'trap draw WINCH',
  'draw',
  'while :; do',
  '  next=$(cat "$state" 2>/dev/null)',
  '  if [ -n "$next" ] && [ "$next" != "$cur" ]; then',
  '    cur=$next',
  '    printf \'\\033[1;7H%s\\033[K\' "$cur"',
  '    echo "diff:$cur" >> "$state.log"',
  '  fi',
  '  sleep 0.2',
  'done'
].join('\n')

test('an idle full-screen program shows its current frame after a network outage', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(10 * 60_000)
  // Why a holder: assigned inside the callback, which narrowing cannot see.
  const opened: { proxy: FreezableTcpProxy | null } = { proxy: null }
  try {
    await withManagedHost(testInfo, async (fixture) => {
      const { host } = fixture
      const proxy = await startFreezableTcpProxy(host.input.host, host.input.port ?? 22)
      opened.proxy = proxy
      // Why the proxy: the profile reaches sshd only through it, so cutting it is the network.
      host.input = { ...host.input, port: proxy.port }
      const dir = `/tmp/orca-idle-frame-${Date.now()}`
      host.exec!(
        `mkdir -p ${dir} && printf BEFORE > ${dir}/state && cat > ${dir}/tui.sh <<'TUI'\n${TUI_SCRIPT}\nTUI`
      )
      const { page, seeded } = await launchManagedWorkspace(fixture)
      const tabId = await openTerminalTab(page, seeded.worktreeId)
      await typeInTerminal(page, tabId, `bash ${dir}/tui.sh ${dir}/state`)
      await expectPaneText(page, tabId, 'FRAME:BEFORE')

      proxy.cut('reset')
      host.exec!(`printf AFTER > ${dir}/state`)
      await expect
        .poll(() => host.exec!(`cat ${dir}/state.log 2>/dev/null || true`), { timeout: 15_000 })
        .toContain('diff:AFTER')
      await page.waitForTimeout(5_000)
      proxy.restore()

      try {
        await expectPaneText(page, tabId, 'FRAME:AFTER', 180_000)
      } catch (error) {
        console.log(
          '[idle-frame] evidence',
          JSON.stringify({
            pane: (await readPairedPaneContent(page, tabId)).slice(-600),
            hostLog: host.exec!(`cat ${dir}/state.log 2>/dev/null || true`),
            proxyEvents: proxy.events
          })
        )
        await page.screenshot({ path: testInfo.outputPath('after-outage.png') })
        throw error
      }
    })
  } finally {
    await opened.proxy?.close()
  }
})
