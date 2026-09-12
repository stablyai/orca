/** The npm Console wrapper delegates to the generic DSH CLI with an explicit profile. */
export function isDshConsoleProcess(entrypoint: string, args: readonly string[]): boolean {
  const path = entrypoint.replace(/\\/g, '/').toLowerCase()
  if (
    !/(?:^|\/)dsh(?:\.(?:exe|cmd|bat|ps1))?$/.test(path) &&
    !/(?:^|\/)node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/.test(path)
  ) {
    return false
  }
  let profile: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const [option, ...inline] = args[index].split('=')
    if (option === '--dump-config' || option === '--dump-default-config') {
      return false
    }
    if (!['--profile', '--patch', '--from-default-profile'].includes(option)) {
      break
    }
    const value = inline.length ? inline.join('=') : args[++index]
    if (!value || value.startsWith('-')) {
      return false
    }
    if (option === '--profile') {
      profile = value
    }
  }
  return profile === 'dsh-console'
}
