type SimulatorTabReference = {
  id: string
  contentType: string
}

export function shouldShutdownSimulatorForPaneUnmountFromTabs(
  tabs: SimulatorTabReference[],
  tabId?: string
): boolean {
  const simulatorTabs = tabs.filter((tab) => tab.contentType === 'simulator')
  if (tabId && simulatorTabs.some((tab) => tab.id === tabId)) {
    return false
  }
  return simulatorTabs.length === 0
}
