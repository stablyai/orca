const SIM_RUNTIME_RE = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/

// simctl keys devices by runtime identifier, e.g. com.apple.CoreSimulator.SimRuntime.iOS-26-0.
export function simulatorRuntimeLabel(runtime: string | undefined): string | undefined {
  const match = runtime?.match(SIM_RUNTIME_RE)
  return match ? `${match[1]} ${match[2].replaceAll('-', '.')}` : undefined
}
