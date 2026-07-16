import { translate } from '@/i18n/i18n'

export function getWorkspacePortAriaLabel(workspaceCount: number): string {
  // Why: the complete count phrase must remain translatable instead of
  // interpolating English port/ports nouns into another language.
  return workspaceCount === 1
    ? translate(
        'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortAriaLabel',
        'Ports, {{workspaceCount}} workspace port',
        { workspaceCount }
      )
    : translate(
        'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsAriaLabel',
        'Ports, {{workspaceCount}} workspace ports',
        { workspaceCount }
      )
}

export function getWorkspacePortTooltipLabel(
  workspaceCount: number,
  externalCount: number
): string {
  if (externalCount > 0) {
    return workspaceCount === 1
      ? translate(
          'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortWithExternalTooltip',
          'Ports — {{workspaceCount}} workspace port · {{externalCount}} external',
          { workspaceCount, externalCount }
        )
      : translate(
          'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsWithExternalTooltip',
          'Ports — {{workspaceCount}} workspace ports · {{externalCount}} external',
          { workspaceCount, externalCount }
        )
  }

  return workspaceCount === 1
    ? translate(
        'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortTooltip',
        'Ports — {{workspaceCount}} workspace port',
        { workspaceCount }
      )
    : translate(
        'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsTooltip',
        'Ports — {{workspaceCount}} workspace ports',
        { workspaceCount }
      )
}
