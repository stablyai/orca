export function buildAutomationWorkspaceName(
  runTitle: string,
  scheduledFor: number,
  timezone?: string | null
): string {
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone?.trim() || undefined,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(scheduledFor)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  const stamp = `${part('year')}${part('month')}${part('day')}T${part('hour')}${part('minute')}`
  return `auto-${slug || 'run'}-${stamp}`
}
