import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bunOwnedRuntimeArgs } from './bun-owned-runtime-args'
import { runProcess } from './child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE

it.skipIf(!runtime)(
  'loads installed packages but never retrieves missing packages in owned script or eval launches',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-owned-bun-packages-'))
    const requests: string[] = []
    const registry = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":"controlled missing package"}')
    })
    try {
      await new Promise<void>((resolve, reject) => {
        registry.once('error', reject)
        registry.listen(0, '127.0.0.1', resolve)
      })
      const address = registry.address()
      if (!address || typeof address === 'string') {
        throw new Error('The private package registry did not bind a TCP port')
      }
      const installed = join(root, 'installed')
      const missing = join(root, 'missing')
      const home = join(root, 'home')
      const packageDirectory = join(installed, 'node_modules', 'orca-installed-fixture')
      await Promise.all([mkdir(packageDirectory, { recursive: true }), mkdir(missing), mkdir(home)])
      await writeFile(
        join(packageDirectory, 'package.json'),
        JSON.stringify({ name: 'orca-installed-fixture', version: '1.0.0', main: 'index.js' })
      )
      await writeFile(join(packageDirectory, 'index.js'), 'module.exports = "installed-package"')
      const missingName = 'orca-missing-owned-runtime-fixture'
      await writeFile(
        join(missing, 'package.json'),
        JSON.stringify({ name: 'probe', dependencies: { [missingName]: '1.0.0' } })
      )
      const registryUrl = `http://127.0.0.1:${address.port}`
      const npmrc = join(home, '.npmrc')
      await writeFile(npmrc, `registry=${registryUrl}\n`)
      await writeFile(join(missing, '.npmrc'), `registry=${registryUrl}\n`)
      const run = async (cwd: string, source: string, evalMode: boolean, owned = true) => {
        await writeFile(join(cwd, 'entry.cjs'), source)
        return runProcess({
          program: runtime,
          args: [
            ...bunOwnedRuntimeArgs().filter((arg) => owned || arg !== '--no-install'),
            ...(evalMode ? ['-e', source] : ['entry.cjs'])
          ],
          cwd,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: root,
            TMP: root,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: home,
            XDG_CACHE_HOME: join(root, 'cache'),
            BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache'),
            npm_config_registry: registryUrl,
            npm_config_userconfig: npmrc,
            ORCA_BACKGROUND_LAUNCH: '1'
          },
          timeoutMs: 10_000
        })
      }
      for (const evalMode of [false, true]) {
        const present = await run(
          installed,
          'console.log(require("orca-installed-fixture"))',
          evalMode
        )
        expect(present.code, present.stderr).toBe(0)
        expect(present.stdout.trim()).toBe('installed-package')
        const absent = await run(missing, `require('${missingName}')`, evalMode)
        expect(absent.timedOut).toBe(false)
        expect(absent.code).toBe(1)
        expect(absent.stderr).toContain(`Cannot find package '${missingName}'`)
        expect(requests).toEqual([])
      }
      // Prove the same missing import reaches this registry without the owned runtime policy.
      const control = await run(missing, `require('${missingName}')`, false, false)
      expect(control.timedOut).toBe(false)
      expect(control.code).toBe(1)
      expect(requests).toContain(`/${missingName}`)
    } finally {
      registry.closeAllConnections()
      if (registry.listening) {
        await new Promise<void>((resolve) => registry.close(() => resolve()))
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60_000
)
