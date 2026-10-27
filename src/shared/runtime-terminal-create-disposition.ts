/** True only for a reply on this contract that says this call made the terminal; anything else is not. */
export function isTerminalCreatedHere(
  reply: Partial<Record<'isReattach' | 'agentSessionDisposition', unknown>>
): boolean {
  const { isReattach, agentSessionDisposition: disposition } = reply
  return isReattach === undefined && (disposition === undefined || disposition === 'created')
}
