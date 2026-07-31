import { registerModuleSingletonSize } from '../../lib/module-singleton-size-registry'

export const receivedPtyCharTotals = new Map<string, number>()

registerModuleSingletonSize('watchdog.receivedPtyCharTotals', receivedPtyCharTotals)
