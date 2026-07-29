// Argument parsing for `node run.mjs`.
//
// Two installer sources are accepted per side: a local path (--from/--to) or a
// GitHub release tag (--from-release/--to-release) that the harness downloads
// via `gh release download`. Exactly one profile (--expect) is required.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const VALID_PROFILES = new Set(['cold-restore', 'survival'])

const USAGE = `
win-update-e2e — packaged NSIS update proof harness (Windows only)

Usage:
  node tools/win-update-e2e/run.mjs --from <setup.exe> --to <setup.exe> --expect <profile> [options]
  node tools/win-update-e2e/run.mjs --from-release <tag> --to-release <tag> --expect <profile>

Installer source (version N, then N+1) — path or release tag on each side:
  --from <path>            Local orca-windows-setup.exe for the base version (N)
  --to <path>              Local orca-windows-setup.exe for the update (N+1)
  --from-release <tag>     Download N's setup asset via gh (e.g. v1.4.124-rc.9)
  --to-release <tag>       Download N+1's setup asset via gh

Required:
  --expect <profile>       Assertion profile: "cold-restore" or "survival"
                           cold-restore = today's behavior (daemon killed by the
                             installer sweep, app cold-restores scrollback, no
                             flashing). survival = Phase 1 target (daemon PID
                             unchanged, sessions still interactive).

Options:
  --install-dir <path>     Isolated-install mode: install the test build into
                           <path> instead of the default per-user location,
                           leaving a developer's REAL Orca install untouched.
                           The path must be absolute and contain NO SPACES (the
                           NSIS /D override cannot be quoted), must not be the
                           default install location, and must not point at a
                           non-empty directory that is not a prior harness
                           install. Isolated mode snapshots and restores the
                           shared per-user registry keys + shortcuts at teardown
                           so the real install's "next update" target is
                           preserved. See README "Isolated install mode".
  --allow-existing-install Proceed even if an Orca install already exists. The
                           run overwrites it with the --from/--to versions and
                           leaves the --to version installed (your prior build
                           is NOT restored). Without this flag the harness
                           refuses to run when an install exists, to protect a
                           developer's real Orca. Clean machines (CI/VM) never
                           need it. Ignored in --install-dir mode, which never
                           touches the real install.
  --keep-install           Skip teardown/uninstall (leaves the app installed)
  --asset-pattern <glob>   gh release asset glob (default: *windows-setup.exe)
  --soak-seconds <n>       Post-relaunch window watch duration (default: 180)
  -h, --help               Show this help
`

export function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { help: true, usage: USAGE }
  }

  const opts = {
    from: takeValue(argv, '--from'),
    to: takeValue(argv, '--to'),
    fromRelease: takeValue(argv, '--from-release'),
    toRelease: takeValue(argv, '--to-release'),
    expect: takeValue(argv, '--expect'),
    assetPattern: takeValue(argv, '--asset-pattern') ?? '*windows-setup.exe',
    soakSeconds: Number(takeValue(argv, '--soak-seconds') ?? '180'),
    installDir: takeValue(argv, '--install-dir'),
    keepInstall: argv.includes('--keep-install'),
    allowExistingInstall: argv.includes('--allow-existing-install'),
    usage: USAGE
  }

  // Distinguish "--install-dir omitted" from "--install-dir with no value": the
  // latter must fail rather than silently fall back to a non-isolated install.
  const errors = validate(opts, argv.includes('--install-dir'))
  return { ...opts, errors }
}

/** Default per-user oneClick install location: %LOCALAPPDATA%\Programs\Orca. */
function defaultInstallDir() {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return path.join(localAppData, 'Programs', 'Orca')
}

/** True if `child` is equal to, inside, or an ancestor of `parent` (case-insensitive). */
function pathsOverlap(a, b) {
  const na = path
    .resolve(a)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
  const nb = path
    .resolve(b)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
  if (na === nb) {
    return true
  }
  return na.startsWith(`${nb}\\`) || nb.startsWith(`${na}\\`)
}

/** A prior harness install directory carries both the app exe and its uninstaller. */
function looksLikeHarnessInstall(dir) {
  return existsSync(path.join(dir, 'Orca.exe')) && existsSync(path.join(dir, 'Uninstall Orca.exe'))
}

/**
 * Validate --install-dir for isolated-install mode. The NSIS /D override must be
 * the last, unquoted argument, so the path cannot contain spaces. It must also
 * not overlap the default install location (that would defeat isolation) and
 * must not clobber an unrelated non-empty directory.
 */
export function validateInstallDir(installDir) {
  const errors = []
  if (!path.isAbsolute(installDir)) {
    errors.push(`--install-dir must be an absolute path (got "${installDir}")`)
    return errors
  }
  if (/\s/.test(installDir)) {
    errors.push(
      `--install-dir must not contain spaces (got "${installDir}"). The NSIS installer's ` +
        `/D path override must be the last, UNQUOTED argument, so a path with spaces cannot ` +
        `be passed. Choose a spaces-free location (e.g. C:\\OrcaE2E).`
    )
  }
  if (pathsOverlap(installDir, defaultInstallDir())) {
    errors.push(
      `--install-dir "${installDir}" overlaps the default install location ` +
        `"${defaultInstallDir()}". Isolated mode must target a separate directory so the ` +
        `real install is never touched.`
    )
  }
  if (existsSync(installDir)) {
    let entries = []
    try {
      entries = readdirSync(installDir)
    } catch (err) {
      // Fail closed: an unreadable existing directory must not be treated as
      // empty/safe to overwrite.
      errors.push(
        `--install-dir "${installDir}" could not be read (${err.message}). ` +
          `Refusing to treat an unreadable directory as safe to overwrite.`
      )
      return errors
    }
    if (entries.length > 0 && !looksLikeHarnessInstall(installDir)) {
      errors.push(
        `--install-dir "${installDir}" is a non-empty directory that does not look like a ` +
          `prior harness install (no Orca.exe + "Uninstall Orca.exe"). Refusing to overwrite ` +
          `unrelated files. Point at an empty or non-existent directory.`
      )
    }
  }
  return errors
}

function validate(opts, installDirFlagPresent) {
  const errors = []
  if (!opts.from && !opts.fromRelease) {
    errors.push('Missing base installer: pass --from <path> or --from-release <tag>')
  }
  if (opts.from && opts.fromRelease) {
    errors.push('Pass only one of --from / --from-release')
  }
  if (!opts.to && !opts.toRelease) {
    errors.push('Missing update installer: pass --to <path> or --to-release <tag>')
  }
  if (opts.to && opts.toRelease) {
    errors.push('Pass only one of --to / --to-release')
  }
  if (!opts.expect) {
    errors.push('Missing --expect <cold-restore|survival>')
  } else if (!VALID_PROFILES.has(opts.expect)) {
    errors.push(`Invalid --expect "${opts.expect}" (expected cold-restore or survival)`)
  }
  if (!Number.isFinite(opts.soakSeconds) || opts.soakSeconds < 0) {
    errors.push('--soak-seconds must be a non-negative number')
  }
  if (installDirFlagPresent && opts.installDir === undefined) {
    errors.push('--install-dir requires a path value')
  } else if (opts.installDir !== undefined) {
    errors.push(...validateInstallDir(opts.installDir))
  }
  return errors
}

function takeValue(argv, flag) {
  const idx = argv.indexOf(flag)
  if (idx < 0) {
    return undefined
  }
  const value = argv[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    return undefined
  }
  return value
}
