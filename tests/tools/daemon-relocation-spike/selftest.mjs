// Offline validation of the spike's pure logic: argument parsing, tier
// definitions, the tier -> copy-plan resolver, and the app-dir module filter.
// No real build, copy, or launch. `runSelftest()` returns true on all-pass.

import { parseArgs, TIERS } from './cli.mjs'
import { TIER_DEFINITIONS, selectTierDlls, resolveTierFileSet, GPU_DLLS } from './tier-file-set.mjs'
import { findAppDirResidentModules } from './loaded-module-probe.mjs'

function makeSyntheticInventory() {
  const unpackedRoot = 'C:\\App\\resources\\app.asar.unpacked'
  const f = (path) => ({ path, exists: true, size: 1 })
  return {
    appDir: 'C:\\App',
    unpackedRoot,
    hostExe: { name: 'Orca.exe', ...f('C:\\App\\Orca.exe') },
    runtimeData: [
      { name: 'icudtl.dat', ...f('C:\\App\\icudtl.dat') },
      { name: 'snapshot_blob.bin', ...f('C:\\App\\snapshot_blob.bin') },
      { name: 'v8_context_snapshot.bin', ...f('C:\\App\\v8_context_snapshot.bin') }
    ],
    topLevelDlls: [
      { name: 'ffmpeg.dll', ...f('C:\\App\\ffmpeg.dll') },
      { name: 'libEGL.dll', ...f('C:\\App\\libEGL.dll') },
      { name: 'libGLESv2.dll', ...f('C:\\App\\libGLESv2.dll') },
      { name: 'vk_swiftshader.dll', ...f('C:\\App\\vk_swiftshader.dll') },
      { name: 'vulkan-1.dll', ...f('C:\\App\\vulkan-1.dll') },
      { name: 'd3dcompiler_47.dll', ...f('C:\\App\\d3dcompiler_47.dll') }
    ],
    daemonEntry: {
      name: 'daemon-entry.js',
      path: `${unpackedRoot}\\out\\main\\daemon-entry.js`,
      exists: true,
      size: 1,
      relFromUnpacked: 'out/main/daemon-entry.js'
    },
    // node-pty is packaged at resources/node_modules/node-pty — a SIBLING of
    // app.asar.unpacked, NOT under it (see packaged-runtime-node-modules.cjs).
    // The synthetic inventory reflects that so the copy-plan test catches any
    // regression that mislocates it.
    nodePty: {
      exists: true,
      packageDir: 'C:\\App\\resources\\node_modules\\node-pty',
      nativeDir: 'C:\\App\\resources\\node_modules\\node-pty\\build\\Release',
      nativeRel: 'build/Release',
      conptyNode: { name: 'conpty.node', path: 'x', exists: true, size: 1 }
    }
  }
}

function run() {
  const failures = []
  const check = (name, cond) => {
    if (!cond) {
      failures.push(name)
    }
  }

  // ── Argument parsing ────────────────────────────────────────────────
  check('help flag', parseArgs(['--help']).help === true)
  check('selftest flag', parseArgs(['--selftest']).selftest === true)
  check('missing app-dir errors', Boolean(parseArgs(['--work-dir', 'w']).error))
  check('missing work-dir errors', Boolean(parseArgs(['--app-dir', 'a']).error))
  check(
    'bad tier errors',
    Boolean(parseArgs(['--app-dir', 'a', '--work-dir', 'w', '--tier', 'x']).error)
  )
  check('unknown arg errors', Boolean(parseArgs(['--nope']).error))
  const ok = parseArgs(['--app-dir', 'a', '--work-dir', 'w', '--tier', 'no-gpu', '--keep-work-dir'])
  check('valid parse launch', Boolean(ok.launch))
  check('valid parse tier', ok.launch?.tier === 'no-gpu')
  check('valid parse keep', ok.launch?.keepWorkDir === true)
  check(
    'default tier full',
    parseArgs(['--app-dir', 'a', '--work-dir', 'w']).launch?.tier === 'full'
  )

  // ── Tier definitions ────────────────────────────────────────────────
  check(
    'all tiers defined',
    TIERS.every((t) => Boolean(TIER_DEFINITIONS[t]))
  )
  const dlls = makeSyntheticInventory().topLevelDlls
  check('full keeps all dlls', selectTierDlls(dlls, 'full').length === 6)
  check('minimal keeps no dlls', selectTierDlls(dlls, 'minimal').length === 0)
  const noGpu = selectTierDlls(dlls, 'no-gpu').map((d) => d.name)
  check('no-gpu keeps ffmpeg', noGpu.includes('ffmpeg.dll'))
  check('no-gpu drops libEGL', !noGpu.includes('libEGL.dll'))
  check(
    'no-gpu drops all gpu dlls',
    noGpu.every((n) => !GPU_DLLS.has(n.toLowerCase()))
  )
  check('no-gpu count is 1', noGpu.length === 1)

  // ── Copy-plan resolution ────────────────────────────────────────────
  const inv = makeSyntheticInventory()
  for (const tier of TIERS) {
    const plan = resolveTierFileSet(inv, tier)
    check(`${tier}: no warnings`, plan.warnings.length === 0)
    const dests = plan.ops.map((o) => o.destRel)
    check(`${tier}: has exe`, dests.includes('Orca.exe'))
    check(`${tier}: has icu`, dests.includes('icudtl.dat'))
    // destRel mirrors the full win-unpacked layout so the require-closure and
    // node-pty native resolution work verbatim from the copy.
    check(
      `${tier}: has daemon entry`,
      dests.includes('resources/app.asar.unpacked/out/main/daemon-entry.js')
    )
    check(`${tier}: has node-pty dir`, dests.includes('resources/node_modules/node-pty'))
    check(
      `${tier}: node-pty op is a dir`,
      plan.ops.find((o) => o.destRel === 'resources/node_modules/node-pty')?.kind === 'dir'
    )
  }
  const fullDests = resolveTierFileSet(inv, 'full').ops.map((o) => o.destRel)
  check('full plan includes gpu dll', fullDests.includes('vulkan-1.dll'))
  const minimalDests = resolveTierFileSet(inv, 'minimal').ops.map((o) => o.destRel)
  check('minimal plan excludes ffmpeg', !minimalDests.includes('ffmpeg.dll'))
  check('minimal plan excludes gpu dll', !minimalDests.includes('vulkan-1.dll'))

  // Missing required input surfaces a warning rather than throwing.
  const brokenInv = { ...inv, nodePty: { exists: false, conptyNode: null } }
  check('missing node-pty warns', resolveTierFileSet(brokenInv, 'full').warnings.length > 0)

  // ── Module-path filter ──────────────────────────────────────────────
  const appDir = 'C:\\Users\\me\\AppData\\Local\\Programs\\orca'
  const modules = [
    'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\Orca.exe',
    'C:\\Windows\\System32\\kernel32.dll',
    'C:\\Users\\me\\AppData\\Local\\orca-daemon-host\\Orca.exe'
  ]
  const resident = findAppDirResidentModules(modules, appDir)
  check('detects app-dir module', resident.length === 1)
  check('detects the right module', resident[0].toLowerCase().includes('programs\\orca\\orca.exe'))
  // Sibling-prefix must NOT match (C:\...\orca vs C:\...\orca-daemon-host).
  check(
    'sibling prefix not matched',
    findAppDirResidentModules(['C:\\a\\orca-daemon-host\\x.dll'], 'C:\\a\\orca').length === 0
  )
  // Forward/back-slash + case normalization.
  check(
    'slash + case normalized',
    findAppDirResidentModules(['c:/a/ORCA/x.dll'], 'C:\\A\\orca').length === 1
  )
  check(
    'relocated host has zero app-dir modules',
    findAppDirResidentModules(
      ['C:\\work\\daemon-host\\Orca.exe', 'C:\\Windows\\System32\\ntdll.dll'],
      appDir
    ).length === 0
  )

  return failures
}

export function runSelftest() {
  const failures = run()
  if (failures.length === 0) {
    console.log('selftest: PASS (all checks green)')
    return true
  }
  console.error(`selftest: FAIL (${failures.length} check(s))`)
  for (const name of failures) {
    console.error(`  - ${name}`)
  }
  return false
}
