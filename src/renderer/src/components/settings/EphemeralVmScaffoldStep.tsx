import { ArrowRight, Check, Copy } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

// Why: generic by design — the prompt names concrete providers only as examples so the
// agent/skill picks the user's actual one. Orca never commits to a provider list it can't honor.
const SCAFFOLD_PROMPT =
  'Use the ephemeral-vms skill to set up VMs for this repo — scaffold the recipe and scripts ' +
  'for my provider (e.g. Vercel Sandbox, Fly.io, Modal, e2b, or my own SSH host), then walk me ' +
  'through building the base image and signing the agent in.'

type OutlineItem = { title: string; detail: string }

export function EphemeralVmScaffoldStep(): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const outline: OutlineItem[] = [
    {
      title: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineScaffoldTitle',
        'Scaffold the recipe & scripts'
      ),
      detail: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineScaffoldDetail',
        'Writes the orca.yaml recipe and the build/lifecycle scripts for your provider.'
      )
    },
    {
      title: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineImageTitle',
        'Build a reusable VM base image'
      ),
      detail: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineImageDetail',
        "Provisions a VM, installs your repo's toolchain, and snapshots it so future workspaces start fast."
      )
    },
    {
      title: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineAuthTitle',
        'Sign your coding agent into the VM'
      ),
      detail: translate(
        'auto.components.settings.EphemeralVmScaffoldStep.outlineAuthDetail',
        'So every workspace starts already authenticated.'
      )
    }
  ]

  const handleCopy = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(SCAFFOLD_PROMPT)
      useAppStore.getState().recordFeatureInteraction('ephemeral-vm-setup')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(
        translate(
          'auto.components.settings.EphemeralVmScaffoldStep.copyError',
          'Could not copy the prompt.'
        )
      )
    }
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {outline.map((item) => (
          <li key={item.title} className="flex items-start gap-2.5">
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm">{item.title}</div>
              <div className="text-xs text-muted-foreground">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EphemeralVmScaffoldStep.promptHint',
            'Paste this to your agent in a normal workspace for this repo:'
          )}
        </div>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed text-muted-foreground">
            {SCAFFOLD_PROMPT}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0 gap-1.5"
            onClick={() => void handleCopy()}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied
              ? translate('auto.components.settings.EphemeralVmScaffoldStep.copied', 'Copied')
              : translate('auto.components.settings.EphemeralVmScaffoldStep.copy', 'Copy')}
          </Button>
        </div>
      </div>
    </div>
  )
}
