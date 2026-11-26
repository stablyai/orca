/** macOS ps localizes lstart (%c) and vis-encodes non-ASCII argv, and lsof prints non-ASCII paths as \xNN; ps, lsof and netstat run with en_US.UTF-8 to get the parsed shape. */
export function psLocaleEnvironment(): NodeJS.ProcessEnv | undefined {
  return process.platform === 'darwin' ? { ...process.env, LC_ALL: 'en_US.UTF-8' } : undefined
}
