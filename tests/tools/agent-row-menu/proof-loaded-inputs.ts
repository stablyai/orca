import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import {
  assertFrozenSource,
  buildInputsPath,
  digest,
  pairedActivationModules,
  rowMenuModules,
  root,
  sha256,
  type recordBuildInputs
} from './proof-build-inputs'

export async function observeProofRuntime(
  page: Page,
  electronApp: ElectronApplication,
  registerPostElectronShutdownCleanup: (cleanup: () => void) => void,
  testInfo: TestInfo
) {
  const build: ReturnType<typeof recordBuildInputs> = JSON.parse(
    readFileSync(buildInputsPath, 'utf8')
  )
  assert.deepEqual(assertFrozenSource(), { head: build.head, base: build.base, tree: build.tree })
  const identity = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const appPath = app.getAppPath()
    const modules = process.getBuiltinModule('node:module')
    if (!modules || !('createRequire' in modules) || typeof modules.createRequire !== 'function') {
      throw new Error('Electron cannot inspect the loaded main entry')
    }
    const appRequire: NodeJS.Require = modules.createRequire(`${appPath}/package.json`)
    const entry = appRequire.resolve(appPath)
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const preferences: unknown =
      'getLastWebPreferences' in contents && typeof contents.getLastWebPreferences === 'function'
        ? contents.getLastWebPreferences()
        : null
    const preload =
      preferences &&
      typeof preferences === 'object' &&
      'preload' in preferences &&
      typeof preferences.preload === 'string'
        ? preferences.preload
        : null
    return {
      appPath,
      main: appRequire.cache[entry]?.loaded ? entry : null,
      preload,
      userData: app.getPath('userData'),
      versions: process.versions
    }
  })
  const appProcess = electronApp.process()
  registerPostElectronShutdownCleanup(() => {
    assert.ok(appProcess.exitCode !== null || appProcess.signalCode !== null)
    assert.equal(existsSync(identity.userData), false)
    writeFileSync(
      testInfo.outputPath('teardown.json'),
      JSON.stringify({
        pid: appProcess.pid,
        exitCode: appProcess.exitCode,
        signal: appProcess.signalCode,
        profileRemoved: true
      })
    )
  })
  assert.equal(realpathSync(identity.appPath), root)
  assert.ok(identity.main && identity.preload)
  const main = relative(root, identity.main)
  const preload = relative(root, identity.preload)
  const renderer = relative(root, fileURLToPath(page.url()))
  assert.equal(main, join('out', 'main', 'index.js'))
  for (const path of [main, preload, renderer]) {
    assert.equal(digest(path), build.artifacts[path])
  }

  const rendererScripts = new Map<string, string>()
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Debugger.scriptParsed', ({ scriptId, url }) => {
    if (url.startsWith('file:')) {
      rendererScripts.set(relative(root, fileURLToPath(url)), scriptId)
    }
  })
  await cdp.send('Debugger.enable')
  await page.setViewportSize({ width: 1600, height: 1000 })

  const assertServedModules = async (paired: boolean) => {
    const served: Record<string, { path: string; sha256: string }> = {}
    for (const module of paired
      ? [...rowMenuModules, ...pairedActivationModules]
      : rowMenuModules) {
      const path = build.sources[module]?.find((file) => rendererScripts.has(file))
      assert.ok(path, `Renderer did not load a chunk mapped to ${module}`)
      const scriptId = rendererScripts.get(path)!
      const content = await cdp.send('Debugger.getScriptSource', { scriptId })
      const hash = sha256(content.scriptSource)
      assert.equal(hash, build.artifacts[path], path)
      assert.equal(digest(path), hash, path)
      served[module] = { path, sha256: hash }
    }
    assert.deepEqual(assertFrozenSource(), { head: build.head, base: build.base, tree: build.tree })
    for (const path of [main, preload, renderer]) {
      assert.equal(digest(path), build.artifacts[path], path)
    }
    writeFileSync(
      testInfo.outputPath('loaded-inputs.json'),
      `${JSON.stringify(
        {
          head: build.head,
          identity,
          main,
          preload,
          renderer,
          viewport: { width: 1600, height: 1000 },
          served
        },
        null,
        2
      )}\n`
    )
  }

  return { assertServedModules, detach: () => cdp.detach() }
}
