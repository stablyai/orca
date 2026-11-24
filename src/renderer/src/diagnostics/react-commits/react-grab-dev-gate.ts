export type ReactGrabDevEnv = {
  readonly dev: boolean
  readonly enableFlag?: string
}

export function shouldEnableReactGrab(env: ReactGrabDevEnv): boolean {
  // pn dev omits VITE_ENABLE_REACT_GRAB; keep its Cmd/Ctrl+C shortcut unless developers explicitly opt out.
  return env.dev && env.enableFlag !== 'false'
}
