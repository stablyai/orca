import React, { useCallback, useMemo, useState } from 'react'
import type { ClaudeAuthMethod } from '../../../../shared/types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { cn } from '@/lib/utils'
import {
  AnthropicApiKeyForm,
  type AnthropicApiKeySubmit
} from './provider-forms/AnthropicApiKeyForm'
import {
  AnthropicCompatForm,
  type AnthropicCompatSubmit
} from './provider-forms/AnthropicCompatForm'
import {
  AzureFoundryForm,
  type AzureFoundrySubmit
} from './provider-forms/AzureFoundryForm'
import {
  AwsBedrockForm,
  type AwsBedrockSubmit
} from './provider-forms/AwsBedrockForm'
import {
  GoogleVertexForm,
  type GoogleVertexSubmit
} from './provider-forms/GoogleVertexForm'

// Discriminated union for the AddAccountModal submit payload. P1 added the
// two Anthropic-flavored shapes; P2 added Foundry; P3 adds Bedrock + Vertex.
export type AddAccountSubmit =
  | AnthropicApiKeySubmit
  | AnthropicCompatSubmit
  | AzureFoundrySubmit
  | AwsBedrockSubmit
  | GoogleVertexSubmit

// Cards rendered in step 1. Disabled providers carry a "Coming in P2/P3" hint
// but no authMethod (those Edge providers are scheduled for later phases).
type ProviderCard =
  | {
      authMethod: ClaudeAuthMethod
      label: string
      subtitle: string
      enabled: true
    }
  | {
      authMethod: null
      label: string
      subtitle: string
      enabled: false
    }

const PROVIDER_CARDS: readonly ProviderCard[] = [
  {
    authMethod: 'subscription-oauth',
    label: 'Sign in with Claude.ai',
    subtitle: 'OAuth web sign-in',
    enabled: true
  },
  {
    authMethod: 'anthropic-api-key',
    label: 'Anthropic API key',
    subtitle: 'Paste your sk-ant-… key',
    enabled: true
  },
  {
    authMethod: 'anthropic-compat',
    label: 'Anthropic-compatible',
    subtitle: 'z.ai, Moonshot/Kimi, MiniMax, or custom proxy',
    enabled: true
  },
  {
    authMethod: 'aws-bedrock',
    label: 'AWS Bedrock',
    subtitle: 'Anthropic models on AWS (bearer token or IAM chain)',
    enabled: true
  },
  {
    authMethod: 'google-vertex',
    label: 'Google Vertex',
    subtitle: 'Anthropic models on Google Cloud (gcloud ADC)',
    enabled: true
  },
  {
    authMethod: 'azure-foundry',
    label: 'Azure AI Foundry',
    subtitle: 'Anthropic models on Microsoft Azure (API key or Entra ID)',
    enabled: true
  }
]

type Step = 'pick' | 'form'

// Indexes of enabled cards in PROVIDER_CARDS. Used by the roving-tabindex
// keyboard handler to step through focusable cards without crossing disabled
// ones.
const ENABLED_INDEXES = PROVIDER_CARDS.reduce<number[]>((acc, card, idx) => {
  if (card.enabled) {
    acc.push(idx)
  }
  return acc
}, [])

type ProviderGridProps = {
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPickProvider: (provider: ClaudeAuthMethod) => void
}

// Shared ref map. Buttons register themselves on mount so the keyboard
// handler can move focus to the next enabled card. We use a module-scoped
// Map (instead of useRef) so this function can be called directly from tests
// without React's hook dispatcher.
const cardRefs = new Map<number, HTMLButtonElement | null>()

function focusEnabledCard(cardIdx: number): void {
  const el = cardRefs.get(cardIdx)
  el?.focus()
}

function makeKeyDownHandler(
  idx: number,
  onActiveIndexChange: (index: number) => void
): (event: React.KeyboardEvent<HTMLButtonElement>) => void {
  return (event) => {
    const enabledPos = ENABLED_INDEXES.indexOf(idx)
    if (enabledPos < 0) {
      return
    }
    let nextPos = enabledPos
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      nextPos = enabledPos + 1
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      nextPos = enabledPos - 1
    } else {
      return
    }
    const wrapped = (nextPos + ENABLED_INDEXES.length) % ENABLED_INDEXES.length
    const nextCardIdx = ENABLED_INDEXES[wrapped]
    onActiveIndexChange(nextCardIdx)
    focusEnabledCard(nextCardIdx)
  }
}

// Stateless renderer for the picker grid. Returned as a JSX tree of native
// elements so tests can traverse the result of a direct function call.
function renderProviderGrid({
  activeIndex,
  onActiveIndexChange,
  onPickProvider
}: ProviderGridProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Choose a provider"
      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
    >
      {PROVIDER_CARDS.map((card, idx) => {
        const isActiveStop = idx === activeIndex
        return (
          <button
            key={card.label}
            ref={(el) => {
              cardRefs.set(idx, el)
            }}
            type="button"
            role="button"
            aria-label={card.label}
            disabled={!card.enabled}
            // Roving tabindex: exactly one enabled card is the active tab stop.
            tabIndex={card.enabled && isActiveStop ? 0 : -1}
            onClick={() => {
              if (card.enabled) {
                onPickProvider(card.authMethod)
              }
            }}
            onFocus={() => {
              if (card.enabled) {
                onActiveIndexChange(idx)
              }
            }}
            onKeyDown={makeKeyDownHandler(idx, onActiveIndexChange)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-md border border-border/50 bg-background p-3 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
              card.enabled
                ? 'hover:bg-accent hover:text-accent-foreground cursor-pointer'
                : 'cursor-not-allowed opacity-50'
            )}
          >
            <div className="text-sm font-semibold">{card.label}</div>
            <div className="text-xs text-muted-foreground">{card.subtitle}</div>
          </button>
        )
      })}
    </div>
  )
}

// Validation probe shape used by the Foundry form. Wired in P2 T21 to the
// `claudeAccounts.validateInput` IPC via `validateInputViaIpc` below.
type ValidateInputFn = (
  input: AddAccountSubmit
) => Promise<{ ok: boolean; message?: string }>

/**
 * Bridge the renderer's `{ ok, message? }` form contract onto the IPC's locked
 * `ClaudeAccountValidationResult` shape (`{ ok: true } | { ok: false, reason,
 * rescueHint? }`). Exported so the AddAccountModal test can mock the IPC
 * boundary without rendering the stateful Dialog.
 */
export async function validateInputViaIpc(
  input: AddAccountSubmit
): Promise<{ ok: boolean; message?: string }> {
  const result = await window.api.claudeAccounts.validateInput(input)
  return { ok: result.ok, message: result.ok ? undefined : result.reason }
}

type AddAccountModalFormViewProps = {
  picked: ClaudeAuthMethod | null
  onSubmit: (input: AddAccountSubmit) => void
  onBack: () => void
  onValidate: ValidateInputFn
}

/**
 * Stateless step-2 view. Picks the provider-specific form by `picked` and
 * wires its onSubmit/onBack/onValidate through to the parent.
 *
 * Exported so tests can call it directly without going through the stateful
 * `AddAccountModal` wrapper.
 */
export function AddAccountModalFormView({
  picked,
  onSubmit,
  onBack,
  onValidate
}: AddAccountModalFormViewProps): React.JSX.Element {
  if (picked === 'anthropic-api-key') {
    return <AnthropicApiKeyForm onSubmit={onSubmit} onCancel={onBack} />
  }
  if (picked === 'anthropic-compat') {
    return <AnthropicCompatForm onSubmit={onSubmit} onCancel={onBack} />
  }
  if (picked === 'azure-foundry') {
    return (
      <AzureFoundryForm
        onSubmit={onSubmit}
        onBack={onBack}
        onValidate={(input) => onValidate(input)}
      />
    )
  }
  if (picked === 'aws-bedrock') {
    return (
      <AwsBedrockForm
        onSubmit={onSubmit}
        onBack={onBack}
        onValidate={(input) => onValidate(input)}
      />
    )
  }
  if (picked === 'google-vertex') {
    return (
      <GoogleVertexForm
        onSubmit={onSubmit}
        onBack={onBack}
        onValidate={(input) => onValidate(input)}
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">
        Form placeholder for <span className="font-mono">{picked ?? 'unknown'}</span>
      </div>
      <div>
        <Button variant="outline" onClick={onBack} aria-label="Back">
          Back
        </Button>
      </div>
    </div>
  )
}

type AddAccountModalBodyProps = {
  step: Step
  pickedProvider: ClaudeAuthMethod | null
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPickProvider: (provider: ClaudeAuthMethod) => void
  onBack: () => void
  onSubmit?: (input: AddAccountSubmit) => void
  onValidate?: ValidateInputFn
}

/**
 * Renders the modal contents for either the picker step or the form step.
 *
 * Exported as a stateless controlled view so tests can call it directly as a
 * function (the project's test pattern) without React's hook dispatcher. The
 * stateful wiring lives in `AddAccountModal` below.
 */
export function AddAccountModalBody({
  step,
  pickedProvider,
  activeIndex,
  onActiveIndexChange,
  onPickProvider,
  onBack,
  onSubmit,
  onValidate
}: AddAccountModalBodyProps): React.JSX.Element {
  if (step === 'pick') {
    return renderProviderGrid({
      activeIndex,
      onActiveIndexChange,
      onPickProvider
    })
  }

  return (
    <AddAccountModalFormView
      picked={pickedProvider}
      onSubmit={(payload) => onSubmit?.(payload)}
      onBack={onBack}
      onValidate={onValidate ?? (async () => ({ ok: true }))}
    />
  )
}

type AddAccountModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: AddAccountSubmit) => void
}

export function AddAccountModal({
  open,
  onOpenChange,
  onSubmit
}: AddAccountModalProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('pick')
  const [pickedProvider, setPickedProvider] = useState<ClaudeAuthMethod | null>(null)
  // Roving tabindex active stop. Initialized to the first enabled card so
  // keyboard users can tab into the grid and then arrow across cards.
  const [activeIndex, setActiveIndex] = useState<number>(ENABLED_INDEXES[0] ?? 0)

  const handlePick = useCallback((provider: ClaudeAuthMethod) => {
    setPickedProvider(provider)
    setStep('form')
  }, [])

  const handleBack = useCallback(() => {
    setStep('pick')
    setPickedProvider(null)
  }, [])

  const title = useMemo(
    () => (step === 'pick' ? 'Add account' : 'Configure account'),
    [step]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            Choose how this account authenticates with Claude.
          </DialogDescription>
        </DialogHeader>
        <AddAccountModalBody
          step={step}
          pickedProvider={pickedProvider}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onPickProvider={handlePick}
          onBack={handleBack}
          onSubmit={onSubmit}
          // P2 T21 — Detect/Validate now hits the real IPC probe.
          onValidate={validateInputViaIpc}
        />
      </DialogContent>
    </Dialog>
  )
}
