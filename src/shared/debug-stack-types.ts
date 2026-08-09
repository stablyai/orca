export type Thread = {
  id: number
  name: string
}

export type StackFrame = {
  id: number
  threadId: number
  name: string
  path?: string
  line: number
  column: number
}

export type Scope = {
  name: string
  variablesReference: number
  expensive: boolean
}

export type Variable = {
  name: string
  value: string
  type?: string
  /** Non-zero when this variable is itself expandable (object/array); pass to a further `getVariables` call. */
  variablesReference: number
}
