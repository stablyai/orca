import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { buildAgentStartupPlan } from './tui-agent-startup'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
const shells = ['bash', 'zsh', 'fish'].filter(
  (shell) =>
    process.platform !== 'win32' &&
    (process.env.PATH ?? '')
      .split(delimiter)
      .some((directory) => existsSync(join(directory, shell)))
)
it.each(shells)(
  'preserves same-shell function argv, one launch and exit status in %s',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-fresh-shell-'))
    roots.push(root)
    const config = join(root, 'fresh settings.yml')
    const capture = join(root, 'argv')
    await writeFile(config, 'autoResume: false\n')
    const plan = buildAgentStartupPlan({
      agent: 'omp',
      prompt: 'task with spaces',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true
    })
    expect(plan).not.toBeNull()
    const define =
      shell === 'fish'
        ? 'function omp; printf "%s\\n" $argv >> "$CAPTURE"; return 17; end; '
        : 'omp() { printf "%s\\n" "$@" >> "$CAPTURE"; return 17; }; '
    const result = await runProcess({
      program: shell,
      args: ['-c', define + plan!.launchCommand],
      cwd: root,
      env: { ...process.env, ORCA_OMP_FRESH_CONFIG: config, CAPTURE: capture }
    })
    expect(result.code).toBe(17)
    expect(await readFile(capture, 'utf8')).toBe(`--config\n${config}\ntask with spaces\n`)
    await rm(capture)
    await rm(config)
    const missing = await runProcess({
      program: shell,
      args: ['-c', define + plan!.launchCommand],
      cwd: root,
      env: { ...process.env, ORCA_OMP_FRESH_CONFIG: config, CAPTURE: capture }
    })
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('fresh OMP settings are unavailable')
    await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' })
    const unsetEnv: NodeJS.ProcessEnv = { ...process.env, CAPTURE: capture }
    delete unsetEnv.ORCA_OMP_FRESH_CONFIG
    const unset = await runProcess({
      program: shell,
      args: ['-c', (shell === 'fish' ? '' : 'set -u; ') + define + plan!.launchCommand],
      cwd: root,
      env: unsetEnv
    })
    expect(unset.code).not.toBe(0)
    expect(unset.stderr).toContain('fresh OMP settings are unavailable')
    await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
