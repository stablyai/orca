import { _electron as electron } from '@stablyai/playwright-test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLoadingProcessOwner } from './main-startup-loading-processes.mjs'

if (process.platform !== 'linux') {
  throw new Error('This isolated-profile benchmark supports Linux only; use a native platform rig')
}

const options = { appRoot: process.cwd(), output: null, idleMs: 120_000, runs: 3 }
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (name === '--app-root') {
    options.appRoot = resolve(value)
  } else if (name === '--output') {
    options.output = resolve(value)
  } else if (name === '--idle-ms') {
    options.idleMs = Number(value)
  } else if (name === '--runs') {
    options.runs = Number(value)
  } else {
    throw new Error(`Unknown argument: ${name}`)
  }
}
if (
  !Number.isSafeInteger(options.runs) ||
  options.runs < 1 ||
  !Number.isSafeInteger(options.idleMs) ||
  options.idleMs < 0
) {
  throw new Error('runs must be positive and idle-ms must be nonnegative integers')
}

const results = []
for (let run = 0; run < options.runs; run += 1) {
  const profile = mkdtempSync(join(tmpdir(), 'orca-main-loading-'))
  try {
    const isolatedHome = join(profile, 'home')
    mkdirSync(isolatedHome)
    const inheritedKeys = new Set([
      'PATH',
      'SHELL',
      'DISPLAY',
      'XAUTHORITY',
      'LANG',
      'LANGUAGE',
      'TZ',
      'LD_LIBRARY_PATH'
    ])
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => inheritedKeys.has(name) || name.startsWith('LC_')
      )
    )
    const started = Date.now()
    const app = await electron.launch({
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        join(options.appRoot, 'out', 'main', 'index.js')
      ],
      env: {
        ...cleanEnv,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        XDG_CONFIG_HOME: join(isolatedHome, '.config'),
        XDG_CACHE_HOME: join(isolatedHome, '.cache'),
        XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
        XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
        NODE_ENV: 'development',
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_DEV_USER_DATA_PATH: join(profile, 'userData'),
        ORCA_TELEMETRY_DISABLED: '1'
      },
      timeout: 120_000
    })
    const owner = createLoadingProcessOwner(app.process(), profile)
    if (process.env.ORCA_MAIN_LOADING_TRACE === '1') {
      app.process().stderr?.on('data', (data) => process.stderr.write(data))
    }
    try {
      const page = await app.firstWindow({ timeout: 120_000 })
      await page.waitForLoadState('domcontentloaded')
      const loadedAt = Date.now()
      const loadedMs = loadedAt - started
      await page.waitForFunction(
        () => document.getElementById('root')?.childElementCount > 0,
        undefined,
        { timeout: 120_000 }
      )
      await page.waitForTimeout(Math.max(0, options.idleMs - (Date.now() - loadedAt)))
      const sample = await app.evaluate(async ({ app }) => {
        const module = process.getBuiltinModule('module')
        const require = module.createRequire(`${app.getAppPath()}/package.json`)
        const loadedFiles = Object.keys(require.cache)
        return {
          pid: process.pid,
          versions: { electron: process.versions.electron, node: process.versions.node },
          paths: { home: app.getPath('home'), userData: app.getPath('userData') },
          memory: process.memoryUsage(),
          processMemory: await process.getProcessMemoryInfo(),
          heap: process.getBuiltinModule('v8').getHeapStatistics(),
          loadedChunks: loadedFiles.filter((file) => /[\\/]out[\\/]main[\\/]/.test(file)),
          loadedDependencies: loadedFiles.filter((file) => /[\\/]node_modules[\\/]/.test(file)),
          dependencyParents: loadedFiles
            .filter((file) => /[\\/]node_modules[\\/](yaml|ssh2|posthog-node)[\\/]/.test(file))
            .map((file) => ({ file, parent: require.cache[file].parent?.filename })),
          windowCount: app.getAppMetrics().filter((entry) => entry.type === 'Tab').length,
          windows: require('electron')
            .BrowserWindow.getAllWindows()
            .map((window) => ({
              visible: window.isVisible(),
              url: window.webContents.getURL()
            }))
        }
      })
      if (sample.windows.some((window) => window.visible)) {
        throw new Error('Benchmark window was presented; refusing invalid background evidence')
      }
      if (sample.windowCount !== 1 || sample.windows.length !== 1) {
        throw new Error('Benchmark requires exactly one renderer and one hidden window')
      }
      if (
        sample.windows[0].url !==
        pathToFileURL(join(options.appRoot, 'out', 'renderer', 'index.html')).href
      ) {
        throw new Error('Benchmark renderer did not load the requested production bundle')
      }
      if (
        sample.paths.home !== isolatedHome ||
        sample.paths.userData !== join(profile, 'userData')
      ) {
        throw new Error('Benchmark app paths escaped the isolated profile')
      }
      results.push({ run: run + 1, loadedMs, idleMs: options.idleMs, ...sample })
      console.log(JSON.stringify({ run: run + 1, loadedMs, memory: sample.memory }))
    } finally {
      await owner.close(app)
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
const report = {
  appRoot: options.appRoot,
  platform: process.platform,
  arch: process.arch,
  presentation: 'hidden',
  telemetry: 'disabled',
  results
}
if (options.output) {
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
} else {
  console.log(JSON.stringify(report, null, 2))
}
