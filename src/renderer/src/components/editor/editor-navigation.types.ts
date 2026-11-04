import type { DIRECTION } from './editor-navigation.consts'
import type { MutableRefObject } from 'react'
import type { editor, IPosition } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'

export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION]

export type Location = Readonly<{
  file: OpenFile
  ownerKey: string
  tabId?: string
  viewStateId?: string
  position: IPosition
  scrollTop: number
  scrollLeft: number
}>

export type HistoryState = Readonly<{
  entries: readonly Location[]
  index: number
}>

export type HistoryStateRef = { current: HistoryState }
export type CanVisitLocation = (location: Location) => boolean

export type History = {
  record: (location: Location, explicitJump?: boolean) => void
  update: (location: Location) => void
  replaceCurrent: (location: Location) => void
  step: (direction: Direction, canVisit?: CanVisitLocation) => Location | null
}

export type EditorParams = {
  editorInstance: editor.IStandaloneCodeEditor
  fileIdRef: MutableRefObject<string>
  viewStateId?: string
  ownerKey: string
}

export type RecordingState = { location: Location | null }

export type Recorder = {
  snapshot: () => Location | null
  record: (explicitJump?: boolean) => void
  update: () => void
}

export type MountedEditor = {
  editor: editor.IStandaloneCodeEditor
  record: () => void
}

export type RestorationState = {
  pending: Location | null
  editors: Map<string, MountedEditor>
}

export type Target = Pick<Location, 'file' | 'tabId'>
export type FileDescriptor = Omit<OpenFile, 'id' | 'isDirty'>
