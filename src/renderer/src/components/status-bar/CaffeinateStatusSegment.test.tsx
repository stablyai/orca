import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { AwakeEnginePicker } from './AwakeEnginePicker'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'
import type { ComputerAwakeStatus } from '../../../../shared/computer-awake-mode'

const mocks = vi.hoisted(() => ({
  paired: false,
  platform: 'darwin' as NodeJS.Platform,
  settings: {
    computerAwakeMode: 'auto',
    keepComputerAwakeWhileAgentsRun: true,
    computerAwakeMacosEngine: 'amphetamine'
  },
  status: {
    mode: 'auto',
    active: false,
    amphetamineInstalled: true,
    amphetamineActive: false
  } as ComputerAwakeStatus,
  updateSettings: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: mocks.settings, updateSettings: mocks.updateSettings })
}))

vi.mock('@/hooks/computer-awake-status', () => ({
  useComputerAwakeStatus: () => mocks.status
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => mocks.paired
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => mocks.platform
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, onElement: (element: ReactElementLike) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, onElement))
    return
  }
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return
  }
  const element = node as ReactElementLike
  onElement(element)
  visit((element.props as { children?: unknown }).children, onElement)
}

function findElement(
  node: unknown,
  predicate: (element: ReactElementLike) => boolean
): ReactElementLike {
  let match: ReactElementLike | null = null
  visit(node, (element) => {
    if (!match && predicate(element)) {
      match = element
    }
  })
  if (!match) {
    throw new Error('element not found')
  }
  return match
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join(' ')
  }
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return ''
  }
  return textContent((node as ReactElementLike).props.children)
}

describe('CaffeinateStatusSegment effective identity', () => {
  beforeEach(() => {
    mocks.paired = false
    mocks.platform = 'darwin'
    mocks.settings.computerAwakeMacosEngine = 'amphetamine'
    mocks.status = {
      mode: 'auto',
      active: false,
      amphetamineInstalled: true,
      amphetamineActive: false
    }
  })

  it('shows Caffeinate when the configured integration is not active', () => {
    const tree = CaffeinateStatusSegment({ iconOnly: false })
    const trigger = findElement(tree, (element) => element.type === 'button')
    const menuLabel = findElement(tree, (element) => element.type === DropdownMenuLabel)
    const picker = findElement(tree, (element) => element.type === AwakeEnginePicker)

    expect(trigger.props['aria-label']).toBe('Caffeinate, Agent · Inactive')
    expect(textContent(menuLabel)).toContain('Agent · Inactive')
    const engineTrigger = findElement(tree, (element) => element.type === DropdownMenuSubTrigger)
    expect(textContent(engineTrigger)).toContain('Amphetamine')
    expect(picker.props.engine).toBe('amphetamine')
  })

  it('shows Caffeinate + Amphetamine only while the integration is active', () => {
    mocks.status = { ...mocks.status, active: true, amphetamineActive: true }

    const tree = CaffeinateStatusSegment({ iconOnly: false })
    const trigger = findElement(tree, (element) => element.type === 'button')
    const menuLabel = findElement(tree, (element) => element.type === DropdownMenuLabel)

    expect(trigger.props['aria-label']).toBe('Caffeinate + Amphetamine, Agent · Active')
    expect(textContent(menuLabel)).toContain('Agent · Active')
  })

  it('names the primary mode group and exposes the engine submenu', () => {
    const tree = CaffeinateStatusSegment({ iconOnly: false })
    const elements: ReactElementLike[] = []
    visit(tree, (element) => elements.push(element))
    const modeGroup = findElement(tree, (element) => element.type === DropdownMenuRadioGroup)

    expect(modeGroup.props['aria-label']).toBe('Keep awake')
    expect(elements.some((element) => element.type === DropdownMenuSubTrigger)).toBe(true)
  })

  it('treats an omitted mixed-version activity field as Caffeinate', () => {
    mocks.status = {
      mode: 'auto',
      active: false,
      amphetamineInstalled: true
    }

    const tree = CaffeinateStatusSegment({ iconOnly: false })
    const trigger = findElement(tree, (element) => element.type === 'button')

    expect(trigger.props['aria-label']).toBe('Caffeinate, Agent · Inactive')
  })

  it('renders nothing in a paired web client', () => {
    mocks.paired = true

    expect(CaffeinateStatusSegment({ iconOnly: false })).toBeNull()
  })
})
