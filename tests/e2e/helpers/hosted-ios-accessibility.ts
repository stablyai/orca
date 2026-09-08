import { restartHostedIosEmulatorController } from '../../../mobile/scripts/hosted-ios-emulator-accessibility.mjs'
import {
  runHostedIosEmulatorCommand,
  type HostedIosEmulatorCommandOptions
} from './hosted-ios-emulator-command'

export type HostedIosAccessibilityNode = {
  children?: HostedIosAccessibilityNode[]
  enabled?: boolean
  frame?: { height?: number; width?: number; x?: number; y?: number }
  label?: string
  value?: string
}

export async function waitForHostedIosAccessibilityControl(
  args: HostedIosEmulatorCommandOptions,
  label: string,
  timeoutMs: number,
  useLastOccurrence = false
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs
  let lastLabels: string[] = []
  while (Date.now() < deadline) {
    const nodes = await readHostedIosAccessibilityNodes(args)
    lastLabels = accessibilityLabels(nodes)
    const controls = nodes.filter((node) => {
      const matches = node.label === label || node.value === label
      return matches && node.enabled !== false && node.frame && isFiniteFrame(node.frame)
    })
    const control = useLastOccurrence ? controls.at(-1) : controls[0]
    if (control?.frame) {
      return {
        x: control.frame.x! + control.frame.width! / 2,
        y: control.frame.y! + control.frame.height! / 2
      }
    }
    await delay(250)
  }
  throw new Error(`${label} was not accessible. Last labels: ${JSON.stringify(lastLabels)}`)
}

export async function readHostedIosAccessibilityNodes(
  args: HostedIosEmulatorCommandOptions
): Promise<HostedIosAccessibilityNode[]> {
  // Why: one serve-sim AX timeout can consume the command's 30-second boundary.
  const deadline = Date.now() + 45_000
  let didRestartController = false
  while (true) {
    try {
      return await readHostedIosAccessibilityNodesOnce(args)
    } catch (error) {
      if (!isTransientAccessibilityReadError(error) || Date.now() >= deadline) {
        throw error
      }
      if (!didRestartController) {
        didRestartController = true
        await restartHostedIosEmulatorController(args, runHostedIosEmulatorCommand)
      }
      await delay(250)
    }
  }
}

async function readHostedIosAccessibilityNodesOnce(
  args: HostedIosEmulatorCommandOptions
): Promise<HostedIosAccessibilityNode[]> {
  const { stdout } = await runHostedIosEmulatorCommand(args, ['ax'])
  const response = JSON.parse(stdout) as { ok?: unknown; result?: unknown }
  if (response.ok !== true || !Array.isArray(response.result)) {
    throw new Error('Orca emulator returned an invalid accessibility response')
  }
  return flattenAccessibilityNodes(response.result.filter(isAccessibilityNode))
}

function isTransientAccessibilityReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('emulator_helper_failed') ||
    message.includes('request timed out') ||
    message.includes('emulator command timed out')
  )
}

function flattenAccessibilityNodes(
  roots: HostedIosAccessibilityNode[]
): HostedIosAccessibilityNode[] {
  const result: HostedIosAccessibilityNode[] = []
  const pending = [...roots]
  while (pending.length > 0 && result.length < 2_000) {
    const node = pending.shift()!
    result.push(node)
    if (Array.isArray(node.children)) {
      pending.push(...node.children.filter(isAccessibilityNode))
    }
  }
  return result
}

function isAccessibilityNode(value: unknown): value is HostedIosAccessibilityNode {
  return Boolean(value && typeof value === 'object')
}

function isFiniteFrame(
  frame: NonNullable<HostedIosAccessibilityNode['frame']>
): frame is { height: number; width: number; x: number; y: number } {
  return [frame.x, frame.y, frame.width, frame.height].every(
    (value) => typeof value === 'number' && Number.isFinite(value)
  )
}

function accessibilityLabels(nodes: HostedIosAccessibilityNode[]): string[] {
  return nodes.flatMap((node) =>
    [node.label, node.value].filter((value): value is string => Boolean(value))
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
