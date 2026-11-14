const { build } = require('esbuild')
const { runProcess } = require('@orca/process-host')
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parseArgs } = require('node:util')
const {
  resolveElectronProbeLaunch
} = require('../../../src/main/browser/electron-fixtures/electron-probe-display-launch.ts')

;(async () => {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      'default-renderer': { type: 'boolean' },
      output: { type: 'string' },
      scale: { type: 'string', default: '2' }
    }
  })
  if (!['2', '3'].includes(values.scale)) {
    throw new Error('--scale must be 2 or 3')
  }
  const source = path.resolve(values.source ?? path.join(__dirname, '../../..'))
  const root = mkdtempSync(path.join(tmpdir(), 'orca-raster-check-'))
  const output = path.resolve(values.output ?? path.join(root, 'results'))
  mkdirSync(output, { recursive: true })
  try {
    await build({
      entryPoints: [path.join(__dirname, 'raster-stream-fixture.ts')],
      outfile: path.join(root, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [
        {
          name: 'isolated-profile-boundaries',
          setup(build) {
            build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/src\// }, (args) => ({
              path: `${path.join(source, args.path.slice(9))}.ts`
            }))
            build.onResolve(
              {
                filter:
                  /(browser-session-registry|browser-javascript-dialogs|remote-cli-page-admission|shared\/constants)$/
              },
              (args) => ({ path: args.path, namespace: 'fixture' })
            )
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents: args.path.endsWith('browser-session-registry')
                ? 'export const browserSessionRegistry={getDefaultProfile:()=>({id:"probe",partition:"raster-probe"}),getProfile:()=>null}'
                : args.path.endsWith('browser-javascript-dialogs')
                  ? 'export const installBrowserJavaScriptDialogs=()=>{}; export const getBrowserJavaScriptDialog=()=>null; export const answerBrowserJavaScriptDialog=()=>{}'
                  : args.path.endsWith('remote-cli-page-admission')
                    ? 'export const assertRemoteCliPageAccess=()=>{}; export const readRemoteCliAdmittedPage=(_id,fn)=>fn(); export const trackRemoteCliInput=(_id,_method,_params,fn)=>fn()'
                    : 'export {}'
            }))
          }
        }
      ]
    })
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const launch = resolveElectronProbeLaunch({
      electronBinary: require('electron'),
      electronArgs: [path.join(root, 'main.cjs')],
      platform: process.platform,
      display: env.DISPLAY
    })
    const result = await runProcess({
      program: launch.executable,
      args: launch.args,
      detached: process.platform !== 'win32',
      timeoutMs: 35000,
      maxOutputBytes: 128 * 1024,
      env: {
        ...env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_EXPERIMENTAL_BROWSER_RASTER_SCALE: values['default-renderer'] ? '' : values.scale,
        RASTER_DPR: values.scale,
        RASTER_USER_DATA: path.join(root, 'user-data'),
        RASTER_FIXTURE: path.join(__dirname, 'raster-check.html'),
        RASTER_OUTPUT: output
      }
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.timedOut) {
      throw new Error('Raster check timed out')
    }
    process.exitCode = result.code ?? 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})()
