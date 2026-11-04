import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { runProcess } from '@orca/process-host'

test.use({ seedTestRepo: false })

test('real WSL registration preserves literal paths and fences login output', async ({
  orcaPage
}, testInfo) => {
  const distro = process.env.ORCA_REAL_WSL_DISTRO
  test.skip(process.platform !== 'win32' || !distro, 'Requires a real Windows WSL distro')
  const { buildWslExecArgs, buildWslCapturedLoginShellCommand } =
    await import('../../src/shared/wsl-login-shell-command')
  const { quotePosixShell } = await import('../../src/shared/shell/launch/shell-argument-quoting')
  const root = `/tmp/or60risk/run-${Date.now()}`
  const repoPath = `${root}/repo-$literal space`
  const uncPath = `\\\\wsl.localhost\\${distro}${repoPath.replaceAll('/', '\\')}`
  const setup = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, [
      '/bin/sh',
      '-c',
      `mkdir -p ${quotePosixShell(`${repoPath}/nested`)} && git init ${quotePosixShell(repoPath)}`
    ]),
    timeoutMs: 30_000
  })
  expect(setup.code, setup.stderr).toBe(0)
  try {
    const capture = buildWslCapturedLoginShellCommand(
      `git -C ${quotePosixShell(repoPath)} rev-parse --is-inside-work-tree`
    )
    const raw = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, [
        '/bin/sh',
        '-c',
        `printf 'OR60_LOGIN_NOISE\\n'; ${capture.command}`
      ]),
      timeoutMs: 30_000
    })
    expect(raw.code, raw.stderr).toBe(0)
    expect(raw.stdout).toContain('OR60_LOGIN_NOISE')
    expect(capture.readStdout(raw.stdout)).toBe('true\n')
    await waitForSessionReady(orcaPage)
    const added = await orcaPage.evaluate(
      async (path) => window.api.repos.add({ path }),
      `${uncPath}\\nested`
    )
    expect('repo' in added).toBe(true)
    expect('repo' in added && added.repo.path).toBe(uncPath)
    await orcaPage.screenshot({ path: testInfo.outputPath('wsl-project.png') })
  } finally {
    const cleanup = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, ['/bin/sh', '-c', `rm -rf ${quotePosixShell(root)}`]),
      timeoutMs: 30_000
    })
    expect(cleanup.code, cleanup.stderr).toBe(0)
  }
})
