import type { SessionStateCreator } from '@/store/session-source-write-boundary'
import type { AppState } from '../../../types'
import type { EditorSlice } from './editor-slice'

export type EditorSet = Parameters<SessionStateCreator<AppState, EditorSlice>>[0]
export type EditorGet = Parameters<SessionStateCreator<AppState, EditorSlice>>[1]
