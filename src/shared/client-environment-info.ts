/** Copy-pasteable client environment fields for bug reports and feedback. */
export type ClientEnvironmentInfo = {
  appVersion: string
  platform: string
  osRelease: string
  arch: string
  /** Login/default shell path when known (e.g. SHELL / ComSpec / spawn shell). */
  shell?: string
}

const FOOTER_MARKER = '---'
const ORCA_LINE_PREFIX = 'Orca:'

// Why: match the whole prefilled block (optional Shell line included) so strip
// keeps authored text both above and below — users who click past the footer
// and type must still be able to send.
const CLIENT_ENVIRONMENT_FOOTER_BLOCK =
  /(^|\r?\n)---\r?\nOrca:[^\r\n]*\r?\nOS:[^\r\n]*(?:\r?\nShell:[^\r\n]*)?/

function normalizeEnvironmentValue(value: string): string {
  return value.trim().replace(/[\r\n]+/g, ' ')
}

export function formatClientEnvironmentInfo(info: ClientEnvironmentInfo): string {
  const version = normalizeEnvironmentValue(info.appVersion) || 'unknown'
  const platform = normalizeEnvironmentValue(info.platform) || 'unknown'
  const osRelease = normalizeEnvironmentValue(info.osRelease)
  const arch = normalizeEnvironmentValue(info.arch)
  const osParts = [platform, osRelease, arch ? `(${arch})` : ''].filter(Boolean)
  const lines = [`${ORCA_LINE_PREFIX} ${version}`, `OS: ${osParts.join(' ')}`]
  const shell = info.shell ? normalizeEnvironmentValue(info.shell) : ''
  if (shell) {
    lines.push(`Shell: ${shell}`)
  }
  return lines.join('\n')
}

/** Block appended under error/feedback bodies so reporters always paste env details. */
export function formatClientEnvironmentFooter(info: ClientEnvironmentInfo): string {
  return `${FOOTER_MARKER}\n${formatClientEnvironmentInfo(info)}`
}

export function hasClientEnvironmentFooter(text: string): boolean {
  return CLIENT_ENVIRONMENT_FOOTER_BLOCK.test(text)
}

/** Drop only the env footer block; keep user text above and below it. */
export function stripClientEnvironmentFooter(text: string): string {
  return text.replace(CLIENT_ENVIRONMENT_FOOTER_BLOCK, '$1')
}

export function appendClientEnvironmentFooter(params: {
  message: string
  info: ClientEnvironmentInfo
}): string {
  if (hasClientEnvironmentFooter(params.message)) {
    return params.message
  }
  const footer = formatClientEnvironmentFooter(params.info)
  const base = params.message.trimEnd()
  return base.length > 0 ? `${base}\n\n${footer}` : footer
}
