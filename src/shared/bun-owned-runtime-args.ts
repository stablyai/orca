/** Owned tools must not execute project bunfig preloads or load project dotenv files. */
export function bunOwnedRuntimeArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    '--no-env-file',
    platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
    '--no-install'
  ]
}
