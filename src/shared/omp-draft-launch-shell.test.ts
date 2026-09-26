import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'

const shells = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].filter(
  (shell) =>
    process.platform !== 'win32' &&
    (process.env.PATH ?? '')
      .split(delimiter)
      .some((directory) => existsSync(join(directory, shell)))
)

it.each(
  shells.flatMap((shell) =>
    shell === 'fish'
      ? [{ shell, nounset: false }]
      : [false, true].map((nounset) => ({ shell, nounset }))
  )
)(
  'clears the draft and preserves status in $shell (nounset=$nounset)',
  async ({ shell, nounset }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-omp-draft-'))
    try {
      const config = join(root, 'fresh settings.yml')
      const calls = join(root, 'calls')
      await writeFile(config, 'autoResume: false\n')
      const plan = buildAgentDraftLaunchPlan({
        agent: 'omp',
        draft: 'task with spaces',
        cmdOverrides: {},
        platform: 'linux'
      })
      if (!plan) {
        throw new Error('Expected draft plan')
      }
      const define =
        shell === 'fish'
          ? 'function omp; printf "%s\\n" "$ORCA_OMP_PREFILL" >> "$CAPTURE"; printf agent-stderr >&2; return 17; end; '
          : 'omp() { printf "%s\\n" "$ORCA_OMP_PREFILL" >> "$CAPTURE"; printf agent-stderr >&2; return 17; }; '
      const observe =
        shell === 'fish'
          ? '; set -l result $status; set -q ORCA_OMP_PREFILL; and exit 91; exit $result'
          : '; result=$?; test -z "${ORCA_OMP_PREFILL+x}" || exit 91; exit "$result"'
      for (const present of [true, false]) {
        if (!present) {
          await rm(config)
        }
        const result = await runProcess({
          program: shell,
          args: ['-c', (nounset ? 'set -u; ' : '') + define + plan.launchCommand + observe],
          cwd: root,
          env: { ...process.env, ...plan.env, ORCA_OMP_FRESH_CONFIG: config, CAPTURE: calls }
        })
        expect(result.code, result.stderr).toBe(present ? 17 : 1)
        expect(result.stderr).toContain(
          present ? 'agent-stderr' : 'fresh OMP settings are unavailable'
        )
        if (present) {
          expect(result.stderr).toBe('agent-stderr')
        }
        expect(result.stderr).not.toContain('command substitutions not allowed')
        expect(await readFile(calls, 'utf8')).toBe('task with spaces\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
