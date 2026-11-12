/** Claude chats saved before Ultracode became a switch hold it as their effort: XHigh with it on. */
export function withLegacyUltracodeEffortLifted(
  options: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return options.effort === 'ultracode'
    ? { ...options, effort: 'xhigh', ultracode: options.ultracode ?? 'true' }
    : options
}

/** Ultracode lasts while its chat stays open; a closed or copied chat keeps only its effort level. */
export function withoutChatUltracode(
  options: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (options.ultracode === undefined && options.effort !== 'ultracode') {
    return options
  }
  const { ultracode: _closed, ...kept } = options
  return kept.effort === 'ultracode' ? { ...kept, effort: 'xhigh' } : kept
}
