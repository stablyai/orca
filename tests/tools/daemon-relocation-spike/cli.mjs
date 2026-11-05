// Find the minimal copied run-as-node Orca host that serves real ConPTY without install-dir handles; see README.

export const TIERS = ['full', 'no-gpu', 'minimal']

const USAGE = `
daemon-relocation-spike — minimal relocated daemon-host file-set probe (Windows)

Usage:
  node tests/tools/daemon-relocation-spike/spike.mjs --app-dir <win-unpacked> --work-dir <temp out> [--tier <t>]
  node tests/tools/daemon-relocation-spike/spike.mjs --selftest

Required (launch mode):
  --app-dir <path>    Path to a packaged win-unpacked build (contains Orca.exe)
  --work-dir <path>   Scratch dir for the copied host + logs (created, then removed)

Options:
  --tier <t>          File-set tier to copy: "full" (default), "no-gpu", "minimal"
                        full    = Orca.exe + icudtl.dat + both snapshot blobs +
                                  ALL top-level *.dll + daemon bundle + node-pty
                        no-gpu  = full minus GPU/render DLLs (libEGL, libGLESv2,
                                  vk_swiftshader, vulkan-1, d3dcompiler_47);
                                  ffmpeg.dll kept
                        minimal = Orca.exe + icudtl.dat + both snapshots +
                                  daemon bundle + node-pty only (no top-level DLLs)
  --keep-work-dir     Leave --work-dir on disk after the run (for inspection)
  --selftest          Validate arg parsing, tier defs, and the module-path filter
                        against synthetic inputs. No real build or launch. Exits
                        0 on pass, non-zero on failure.
  -h, --help          Show this help

Exit code is 0 only when the run PASSES: daemon ready, PTY echo round-trips the
nonce, and NO loaded module resolves under --app-dir.
`

export function getUsage() {
  return USAGE
}

// Parse sliced argv into help/selftest/launch/error; return usage errors for caller reporting.
export function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { help: true }
  }
  if (argv.includes('--selftest')) {
    return { selftest: true }
  }

  let appDir = ''
  let workDir = ''
  let tier = 'full'
  let keepWorkDir = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--app-dir' && argv[i + 1]) {
      appDir = argv[i + 1]
      i++
    } else if (arg === '--work-dir' && argv[i + 1]) {
      workDir = argv[i + 1]
      i++
    } else if (arg === '--tier' && argv[i + 1]) {
      tier = argv[i + 1]
      i++
    } else if (arg === '--keep-work-dir') {
      keepWorkDir = true
    } else {
      return { error: `Unknown or incomplete argument: ${arg}` }
    }
  }

  if (!appDir || !workDir) {
    return { error: 'Both --app-dir and --work-dir are required' }
  }
  if (!TIERS.includes(tier)) {
    return { error: `Invalid --tier "${tier}" (expected one of: ${TIERS.join(', ')})` }
  }

  return { launch: { appDir, workDir, tier, keepWorkDir } }
}
