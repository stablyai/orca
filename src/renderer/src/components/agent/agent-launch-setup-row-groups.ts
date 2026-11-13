import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'

/** Speed rows sit apart from the rest; launch also lifts level rows onto speed's line. */
export function agentLaunchSetupRowGroups(rows: SessionOptionDescriptor[], launch: boolean) {
  const isSpeed = (row: SessionOptionDescriptor) =>
    row.id === 'fastMode' || row.id === 'serviceTier'
  const isLevel = (row: SessionOptionDescriptor) =>
    launch && !isSpeed(row) && row.category === 'thought_level' && row.kind.type === 'select'
  return {
    level: rows.filter(isLevel),
    speed: rows.filter(isSpeed),
    rest: rows.filter((row) => !isSpeed(row) && !isLevel(row))
  }
}
