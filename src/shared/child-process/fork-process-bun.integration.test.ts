import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from './run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'isolates same-runtime Bun forks from workspace dotenv and preload code',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-bun-fork-env-'))
    try {
      const parent = join(root, 'parent.cjs')
      const child = join(root, 'child.cjs')
      await build({
        stdin: {
          contents: `import { forkProcess } from './src/shared/child-process/fork-process';
          process.execArgv.length=0;
          forkProcess({modulePath:process.argv[2], cwd:process.argv[3], stdio:['ignore','inherit','inherit','ipc']})
            .on('error', error => { console.error(error);process.exitCode=1 })
            .on('exit', code => { process.exitCode=code??1 })`,
          loader: 'ts',
          resolveDir: process.cwd()
        },
        platform: 'node',
        format: 'cjs',
        bundle: true,
        outfile: parent
      })
      await writeFile(join(root, 'bunfig.toml'), 'preload=["./preload.cjs"]\n')
      await writeFile(join(root, 'preload.cjs'), 'console.log("UNTRUSTED_PRELOAD")')
      await writeFile(join(root, '.env'), 'ORCA_USER_DATA_PATH=foreign-profile\n')
      await writeFile(
        child,
        'console.log(JSON.stringify(process.env.ORCA_USER_DATA_PATH??null));process.disconnect?.()'
      )
      const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
      delete env.ORCA_USER_DATA_PATH
      const result = await runProcess({
        program: runtime,
        args: ['--no-env-file', parent, child, root],
        cwd: process.cwd(),
        env,
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(JSON.parse(result.stdout)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
