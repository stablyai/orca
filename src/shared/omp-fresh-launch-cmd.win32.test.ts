import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { buildAgentStartupPlan } from './tui-agent-startup'

// The setup gate hands the line to cmd as `<wait> && %ORCA_SEQUENCED_STARTUP_COMMAND%`; cmd expands once.
it.skipIf(process.platform !== 'win32')(
  'guards OMP alike when typed or read from a variable',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca omp & (cmd) '))
    try {
      const config = join(root, 'fresh %ORCA_EXPANSION_PROBE% & settings!.yml')
      const capture = join(root, 'argv.json')
      const script =
        'require("fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))'
      await writeFile(join(root, 'argv.js'), `${script}\nprocess.exit(17)\n`)
      await writeFile(join(root, 'omp.cmd'), '@node "%~dp0argv.js" %*\r\n')
      const prompt = 'task 50%! done'
      const plan = buildAgentStartupPlan({
        agent: 'omp',
        prompt,
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })
      const launch = plan?.launchCommand ?? ''
      for (const line of [launch, 'ver >nul && %ORCA_SEQUENCED_STARTUP_COMMAND%']) {
        for (const present of [true, false]) {
          await rm(config, { force: true })
          await rm(capture, { force: true })
          if (present) {
            await writeFile(config, 'autoResume: false\n')
          }
          const result = await runProcess({
            program: 'cmd.exe',
            // Echo on like a pane, so a lost `@` would print the config path.
            args: ['/d'],
            cwd: root,
            env: {
              ...process.env,
              CAPTURE: capture,
              ORCA_EXPANSION_PROBE: 'unexpected',
              ORCA_OMP_FRESH_CONFIG: config,
              ORCA_SEQUENCED_STARTUP_COMMAND: launch
            },
            input: `${line}\r\nexit %errorlevel%\r\n`
          })
          const row = JSON.stringify({ line, present, ...result })
          expect(result.code, row).toBe(present ? 17 : 1)
          expect(result.stdout, row).not.toContain(config)
          if (present) {
            const argv: string[] = JSON.parse(await readFile(capture, 'utf8'))
            // Carets are the cmd quoter's known leak; this pins only that `%!` is not substituted.
            expect([argv[0], argv[1], argv[2]?.replaceAll('^', '')], row).toEqual([
              '--config',
              config,
              prompt
            ])
          } else {
            expect(result.stderr, row).toContain('fresh OMP settings are unavailable')
            await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' })
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
