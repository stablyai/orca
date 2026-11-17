/** Below this much room under the field, the picker opens above it instead. */
const AGENT_LAUNCH_PICKER_MIN_HEIGHT = 240

export type AgentLaunchPickerPlacement = { side: 'top' | 'bottom'; maxHeight: number }

/** Picks the side from the field's position alone, so async pane content cannot flip it between opens. */
export function agentLaunchPickerPlacement(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
  gap: number
): AgentLaunchPickerPlacement {
  const below = Math.floor(viewportHeight - trigger.bottom - gap)
  const above = Math.floor(trigger.top - gap)
  return below >= AGENT_LAUNCH_PICKER_MIN_HEIGHT || below >= above
    ? { side: 'bottom', maxHeight: Math.max(below, 0) }
    : { side: 'top', maxHeight: Math.max(above, 0) }
}
