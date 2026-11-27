/** Below this much room under the field, the picker opens above it instead. */
const AGENT_LAUNCH_PICKER_MIN_HEIGHT = 240
/** A leading choice row, which sits over the tabs and takes its room from the model list. */
const AGENT_LAUNCH_PICKER_LEADING_ROW_HEIGHT = 40

export type AgentLaunchPickerPlacement = {
  side: 'top' | 'bottom'
  maxHeight: number
  boundary?: HTMLElement
}

/** Picks the side from the field's position alone, so async pane content cannot flip it between opens. */
export function agentLaunchPickerPlacement(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
  gap: number,
  leadingRows = 0
): AgentLaunchPickerPlacement {
  const below = Math.floor(viewportHeight - trigger.bottom - gap)
  const above = Math.floor(trigger.top - gap)
  const minHeight =
    AGENT_LAUNCH_PICKER_MIN_HEIGHT + leadingRows * AGENT_LAUNCH_PICKER_LEADING_ROW_HEIGHT
  return below >= minHeight || below >= above
    ? { side: 'bottom', maxHeight: Math.max(below, 0) }
    : { side: 'top', maxHeight: Math.max(above, 0) }
}

export function readAgentLaunchPickerPlacement(
  trigger: HTMLElement,
  gap: number,
  inline?: boolean,
  leadingRows = 0
): AgentLaunchPickerPlacement {
  const boundary = inline ? trigger.closest<HTMLElement>('[data-slot="dialog-content"]') : null
  const rect = trigger.getBoundingClientRect()
  // The inline switcher sits just above the form footer.
  return boundary
    ? { side: 'top', maxHeight: window.innerHeight, boundary }
    : agentLaunchPickerPlacement(rect, window.innerHeight, gap, leadingRows)
}
