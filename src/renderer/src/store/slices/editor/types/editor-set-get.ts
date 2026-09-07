import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { EditorSlice } from './editor-slice'

export type EditorSet = Parameters<StateCreator<AppState, [], [], EditorSlice>>[0]
export type EditorGet = Parameters<StateCreator<AppState, [], [], EditorSlice>>[1]
