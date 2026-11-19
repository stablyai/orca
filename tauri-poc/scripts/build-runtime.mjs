import { build } from 'esbuild'
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_COMMONJS_MODULE_OPTIONS,
  ORCAD_EXTERNAL_MODULES,
  buildOrcadEntry,
  buildOrcadCli,
  orcadChildOutputFilename,
  externalNativeAddons
} from '../../config/scripts/orcad-distribution/server-bundle/orcad-entry-build.mjs'
import { stageOrcadWindowsSecurity } from '../../config/scripts/orcad-distribution/server-bundle/orcad-windows-security.mjs'
import { stageOrcadWindowsCliLauncher } from '../../config/scripts/orcad-distribution/server-bundle/orcad-windows-cli-launcher.mjs'
import { probeWindowsSecurityAddon } from '../../config/scripts/native-build/windows/build-windows-security-addon.mjs'

const root = resolve(import.meta.dirname, '../..')
const output = join(root, '.cache', 'orcad-dev')
mkdirSync(output, { recursive: true })
process.chdir(root)

if (process.platform === 'win32') {
  const addon = join(output, 'windows-security.node')
  const existing = existsSync(addon)
    ? probeWindowsSecurityAddon(process.execPath, addon, process.arch)
    : null
  if (existing?.code !== 0 || existing?.stdout !== 'windows-security-ready') {
    stageOrcadWindowsSecurity(root, output, `win32-${process.arch}`)
  }
  // Tauri's Node runtime has no Electron resources directory; stage the same native
  // launcher Electron ships so CLI registration and child-process PATH parity remain intact.
  stageOrcadWindowsCliLauncher(root, output, `win32-${process.arch}`)
}

for (const entry of Object.values(ORCAD_CHILD_ENTRY_POINTS)) {
  await build({
    ...ORCAD_COMMONJS_MODULE_OPTIONS,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(output, orcadChildOutputFilename(entry)),
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    minify: false,
    sourcemap: false,
    define: { ...ORCAD_COMMONJS_MODULE_OPTIONS.define, 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
}
await buildOrcadEntry(join(output, 'orcad-server.js'))
await buildOrcadCli(join(output, 'out', 'cli', 'index.js'))
console.log('Tauri development runtime built. This is not a release artifact.')
