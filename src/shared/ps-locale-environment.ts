/**
 * The environment for a `ps` whose `lstart=` or `command=` columns Orca parses: English, fixed
 * `lstart` (`Sat Oct 10 00:04:51 2026`) with the user's own UTF-8 argv.
 *
 * Why per platform: macOS `ps` prints `lstart` with the locale's `%c` (en_NZ `Sat 10 Oct`, ja_JP
 * `土 10/10`) and falls back to the C locale, which mangles non-ASCII argv (`M-EM^B`), as soon as
 * the categories differ, so only a uniform en_US.UTF-8 (shipped with every macOS) gives both.
 * procps keeps the field order but localizes the names (de_DE `Fr Okt  9`), and glibc honours a
 * lone `LC_TIME=C`; `LC_ALL` would override it, so it moves to `LC_CTYPE` instead.
 */
export function psLocaleEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    return env
  }
  if (platform === 'darwin') {
    const pinned: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) {
      if (key !== 'LANG' && !key.startsWith('LC_')) {
        pinned[key] = value
      }
    }
    return { ...pinned, LC_ALL: 'en_US.UTF-8' }
  }
  const { LC_ALL: overriding, ...rest } = env
  return { ...rest, ...(overriding ? { LC_CTYPE: overriding } : {}), LC_TIME: 'C' }
}
