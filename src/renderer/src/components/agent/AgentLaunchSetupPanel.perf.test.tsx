// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'
import * as choiceAnalysis from '../../../../shared/agent-choice-args'
import * as choiceSettings from '../../../../shared/agent-choice-settings'
import * as optionScanner from '../../../../shared/command-option-occurrence'
import * as pickerCatalog from '../../../../shared/agent-launch-picker-catalog'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { fetchCodexModelCatalogListing } from '../../lib/codex-model-catalog-reader-test-fixture'

function observeSettingsWork() {
  let depth = 0
  const blank = () => ({ inventories: 0, records: 0, scanners: 0 })
  let counts = { analyses: 0, analyzer: blank(), compiler: blank() }
  const analyze = choiceAnalysis.analyzeAgentChoiceArgs
  const inventory = choiceSettings.agentChoiceSettingsOccurrences
  const scan = optionScanner.findOptionOccurrence
  const analyzer = vi
    .spyOn(choiceAnalysis, 'analyzeAgentChoiceArgs')
    .mockImplementation((...args) => {
      counts.analyses++
      depth++
      try {
        return analyze(...args)
      } finally {
        depth--
      }
    })
  let inventoryDepth = false
  let inAnalysis = false
  const inventories = vi
    .spyOn(choiceSettings, 'agentChoiceSettingsOccurrences')
    .mockImplementation((...args) => {
      const bucket = depth ? counts.analyzer : counts.compiler
      bucket.inventories++
      inventoryDepth = true
      inAnalysis = depth > 0
      try {
        const result = inventory(...args)
        bucket.records += result.length
        return result
      } finally {
        inventoryDepth = false
      }
    })
  const scanners = vi.spyOn(optionScanner, 'findOptionOccurrence').mockImplementation((...args) => {
    if (inventoryDepth) {
      ;(inAnalysis ? counts.analyzer : counts.compiler).scanners++
    }
    return scan(...args)
  })
  return {
    read: () => structuredClone(counts),
    reset: () => {
      counts = { analyses: 0, analyzer: blank(), compiler: blank() }
    },
    stop: () => {
      analyzer.mockRestore()
      inventories.mockRestore()
      scanners.mockRestore()
    }
  }
}

it('bounds effective-settings work for direct analysis, collapsed Chat render and one actual Args edit at 30/300 carriers', async () => {
  const work = observeSettingsWork()
  try {
    for (const count of [0, 30, 300]) {
      work.reset()
      const result = choiceAnalysis.analyzeAgentChoiceArgs(
        'claude',
        count ? Array(count).fill('--settings {}').join(' ') : '--add-dir docs --verbose'
      )
      expect(result.opaqueKeys.has('fastMode')).toBe(false)
      expect(result.occurrences).toEqual([])
      expect(work.read()).toEqual({
        analyses: 1,
        analyzer: { inventories: 1, records: count, scanners: count + 1 },
        compiler: { inventories: 0, records: 0, scanners: 0 }
      })
    }
    const previous = new Map<string, ReturnType<typeof work.read>>()
    for (const count of [30, 300]) {
      for (const value of ['empty', 'true', 'false']) {
        const text = [
          ...Array(count - 1).fill('--settings {}'),
          value === 'empty'
            ? '--settings {}'
            : `--settings '{"fastMode":${value},"env":{"KEEP":"yes"}}'`
        ].join(' ')
        const own: AgentPickerEntry = {
          ...entry,
          defaultSurface: 'chat',
          arguments: text,
          terminal: { model: 'opus', permissionMode: 'own' },
          structured: { model: 'opus', permissionMode: 'own', options: { fastMode: 'false' } },
          catalog: {
            origin: 'probe',
            fetchedAt: 1,
            models: [
              { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }
            ]
          }
        }
        act(() => root.render(null))
        work.reset()
        await act(async () =>
          root.render(
            <TooltipProvider>
              <AgentLaunchSetupPanel
                entry={own}
                initial={{ ...agentPickerDraft(own), arguments: text }}
                onUse={onUse}
              />
            </TooltipProvider>
          )
        )
        const render = work.read()
        expect(host.querySelector('textarea')).toBeNull()
        expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
          value === 'true' ? 'true' : 'false'
        )
        fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
        const input = host.querySelector<HTMLTextAreaElement>('textarea')!
        work.reset()
        fireEvent.change(input, { target: { value: `${input.value} --add-dir src` } })
        const edit = work.read()
        expect(tokenizeStartupCommand(input.value, 'posix')).toMatchObject({
          ok: true,
          tokens: expect.arrayContaining(['--add-dir', 'src'])
        })
        for (const [phase, measured] of Object.entries({ render, edit })) {
          expect(measured.analyses).toBeGreaterThan(0)
          expect(measured.analyses).toBe(phase === 'render' ? 8 : value === 'empty' ? 18 : 19)
          expect(measured.compiler.inventories).toBe(
            value === 'empty' ? 0 : phase === 'render' ? 1 : 3
          )
          expect(measured.analyzer.inventories).toBeLessThanOrEqual(measured.analyses)
          const max = count + 1
          for (const bucket of [measured.analyzer, measured.compiler]) {
            expect(bucket.records).toBeLessThanOrEqual(bucket.inventories * max)
            expect(bucket.scanners).toBeLessThanOrEqual(bucket.inventories * (max + 1))
          }
          const key = `${value}:${phase}`
          if (count === 300) {
            const small = previous.get(key)!
            expect(measured.analyses).toBe(small.analyses)
            expect(measured.compiler.inventories).toBe(small.compiler.inventories)
            expect(measured.analyzer.records + measured.compiler.records).toBeLessThanOrEqual(
              10 * (small.analyzer.records + small.compiler.records)
            )
            expect(measured.analyzer.scanners + measured.compiler.scanners).toBeLessThanOrEqual(
              10 * (small.analyzer.scanners + small.compiler.scanners)
            )
          }
          previous.set(key, measured)
          process.stdout.write(
            `${JSON.stringify({ metric: 'settings-work', count, value, phase, ...measured })}\n`
          )
        }
        fireEvent.click(
          [...host.querySelectorAll('button')].find((b) => b.textContent === 'Launch terminal')!
        )
        const launch = agentPickerLaunchInputs(onUse.mock.calls.at(-1)![0], own)
        expect(tokenizeStartupCommand(launch.agentArgs ?? '', 'posix')).toMatchObject({
          ok: true,
          tokens: expect.arrayContaining(['--add-dir', 'src'])
        })
        if (value !== 'empty') {
          expect(launch.agentArgs).toContain(`"fastMode":${value}`)
          expect(launch.agentArgs).toContain('"KEEP":"yes"')
        }
      }
    }
  } finally {
    work.stop()
  }
})

it('bounds catalog projection independently of raw model operands and retains Codex tier and Cursor composition through the real editor', async () => {
  const { default: capture } =
    await import('../../../../shared/fixtures/agent-picker-cli-recordings.json')
  const listing = await fetchCodexModelCatalogListing({
    connection: { request: vi.fn().mockResolvedValue(capture.modelList) }
  })
  const captured = listing.models[0]
  const tier = captured.serviceTiers![0].value
  const projection = vi.spyOn(pickerCatalog, 'agentPickerEntryOptions')
  const previous = new Map<number, { calls: number; reads: number }>()
  try {
    for (const models of [30, 300]) {
      for (const operands of [30, 300]) {
        let reads = 0
        const own: AgentPickerEntry = {
          ...entry,
          agent: 'codex',
          label: 'Codex',
          defaultSurface: 'terminal',
          arguments: '--add-dir docs',
          terminal: { model: captured.id, permissionMode: 'own' },
          structured: {},
          catalog: {
            origin: 'probe',
            fetchedAt: 1,
            models: Array.from({ length: models }, (_, i) => ({
              ...captured,
              get id() {
                reads++
                return i === models - 1 ? captured.id : `model-${i}`
              },
              label: `Model ${i}`,
              isDefault: i === models - 1,
              efforts: captured.efforts
            }))
          }
        }
        act(() => root.render(null))
        act(() =>
          root.render(
            <TooltipProvider>
              <AgentLaunchSetupPanel
                entry={own}
                initial={{
                  ...agentPickerDraft(own),
                  choices: { options: { serviceTier: tier } }
                }}
                onUse={onUse}
              />
            </TooltipProvider>
          )
        )
        const input = host.querySelector<HTMLTextAreaElement>('textarea')!
        const text = Array(operands).fill('--model raw').join(' ')
        projection.mockClear()
        reads = 0
        fireEvent.change(input, { target: { value: text } })
        const calls = projection.mock.calls.length
        expect(calls).toBe(7)
        expect(reads).toBeLessThanOrEqual((7 + 8) * models + 8)
        if (operands === 300) {
          expect({ calls, reads }).toEqual(previous.get(models))
        }
        previous.set(models, { calls, reads })
        process.stdout.write(
          `${JSON.stringify({ metric: 'catalog-edit', models, operands, calls, reads })}\n`
        )
        expect(input.value).toBe(text)
        expect(
          host.querySelector(`button[aria-label="Remove -c service_tier=${tier}"]`)
        ).not.toBeNull()
        fireEvent.click(
          [...host.querySelectorAll('button')].find((b) => b.textContent === 'Launch terminal')!
        )
        const launch = agentPickerLaunchInputs(onUse.mock.calls.at(-1)![0], own)
        expect(launch.agentArgs).toContain(`service_tier=${tier}`)
        expect(launch.agentArgs?.match(/--model raw/g)).toHaveLength(operands)
      }
    }
    const own: AgentPickerEntry = {
      ...entry,
      agent: 'cursor',
      label: 'Cursor',
      defaultSurface: 'terminal',
      arguments: '--verbose',
      terminal: { model: 'claude-opus-4-8', permissionMode: 'own', options: { fastMode: 'true' } },
      structured: {},
      catalog: { origin: 'unknown' }
    }
    act(() => root.render(null))
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} onUse={onUse} />
        </TooltipProvider>
      )
    )
    fireEvent.change(host.querySelector('textarea')!, {
      target: { value: '--model claude-opus-4-8 --verbose' }
    })
    fireEvent.click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Launch terminal')!
    )
    const launch = agentPickerLaunchInputs(onUse.mock.calls.at(-1)![0], own)
    expect(launch.agentArgs).toContain('--model claude-opus-4-8')
    expect(launch.agentArgs).not.toContain('-fast')
    expect(launch.agentArgs?.match(/--model/g)).toHaveLength(1)
  } finally {
    projection.mockRestore()
  }
})
