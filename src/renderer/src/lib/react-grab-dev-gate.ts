export type ReactGrabDevEnv = {
  readonly dev: boolean
  readonly enableFlag?: string
}

export function shouldEnableReactGrab(env: ReactGrabDevEnv): boolean {
  // Why: `pn dev` does not set VITE_ENABLE_REACT_GRAB; dev builds should keep
  // React Grab's Cmd/Ctrl+C shortcut on unless a developer explicitly opts out.
  return env.dev && env.enableFlag !== 'false'
}
