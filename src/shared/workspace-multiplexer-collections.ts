import {
  EMPTY_WORKSPACE_MULTIPLEXER_STATE,
  type WorkspaceMultiplexerState
} from './workspace-multiplexer-types'

export function getWorkspaceMultiplexerLayouts(state: WorkspaceMultiplexerState) {
  return state.savedLayouts?.length
    ? state.savedLayouts
    : [
        {
          id: 'default',
          name: 'Multiplexer 1',
          layout: { slots: state.slots, panes: state.panes, layout: state.layout }
        }
      ]
}

export function addWorkspaceMultiplexer(
  state: WorkspaceMultiplexerState,
  id: string
): WorkspaceMultiplexerState {
  const layouts = getWorkspaceMultiplexerLayouts(state)
  if (layouts.length >= 24 || layouts.some((item) => item.id === id)) {
    return state
  }
  let number = 1
  while (layouts.some((item) => item.name === `Multiplexer ${number}`)) {
    number++
  }
  const saved = { id, name: `Multiplexer ${number}`, layout: EMPTY_WORKSPACE_MULTIPLEXER_STATE }
  return { ...saved.layout, activeLayoutId: id, savedLayouts: [...layouts, saved] }
}

export function selectWorkspaceMultiplexer(
  state: WorkspaceMultiplexerState,
  id: string
): WorkspaceMultiplexerState {
  const savedLayouts = getWorkspaceMultiplexerLayouts(state)
  const selected = savedLayouts.find((item) => item.id === id)
  return selected ? { ...selected.layout, activeLayoutId: id, savedLayouts } : state
}

export function removeWorkspaceMultiplexer(
  state: WorkspaceMultiplexerState,
  id: string
): WorkspaceMultiplexerState {
  const layouts = getWorkspaceMultiplexerLayouts(state)
  const savedLayouts = layouts.filter((item) => item.id !== id)
  if (savedLayouts.length === layouts.length) {
    return state
  }
  const selected = savedLayouts.find((item) => item.id === state.activeLayoutId) ?? savedLayouts[0]
  return {
    ...(selected?.layout ?? EMPTY_WORKSPACE_MULTIPLEXER_STATE),
    activeLayoutId: selected?.id,
    savedLayouts
  }
}
