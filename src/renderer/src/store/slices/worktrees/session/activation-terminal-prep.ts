export const pendingActivationTerminalPrepCancels = new Map<string, () => void>()

export function shouldDeferActivationTerminalPrep(): boolean {
  return typeof window !== 'undefined' && import.meta.env.MODE !== 'test'
}
