import { useState } from 'react'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import type { VoiceSettings } from '../../../../../shared/speech-types'
import {
  MAX_DICTATION_TERMS,
  MAX_DICTATION_TERM_LENGTH,
  type DictationTerm
} from '../../../../../shared/dictation-dictionary'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { selectRepoByIdForActiveWorkspace } from '@/store/repos/active-workspace-repository'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import {
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from '../form-controls/SettingsFormControls'

type VocabularyScope = 'personal' | 'repo'

type VoiceVocabularySettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

const NO_TERMS: readonly DictationTerm[] = []

export function VoiceVocabularySetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceVocabularySettingProps): React.JSX.Element {
  const t = useTranslate()
  // The repo you're working in; a folder workspace has none, so only personal terms show.
  const repo = useAppStore((s) => selectRepoByIdForActiveWorkspace(s, s.activeRepoId))
  const updateRepo = useAppStore((s) => s.updateRepo)
  const [chosenScope, setScope] = useState<VocabularyScope>('personal')
  // A repo write is a round trip (RPC for a remote host); the next edit builds on it, not on the stored list.
  const [pending, setPending] = useState<{
    repoId: string
    hostId: ExecutionHostId
    terms: DictationTerm[]
  } | null>(null)
  const scope = repo ? chosenScope : 'personal'
  const personalTerms = voiceSettings.dictationTerms ?? NO_TERMS
  const repoTerms =
    pending && repo && pending.repoId === repo.id && pending.hostId === getRepoExecutionHostId(repo)
      ? pending.terms
      : (repo?.dictationTerms ?? NO_TERMS)
  const terms = scope === 'repo' ? repoTerms : personalTerms

  const saveRepoTerms = async (
    repoId: string,
    hostId: ExecutionHostId,
    next: DictationTerm[]
  ): Promise<void> => {
    const write = { repoId, hostId, terms: next }
    setPending(write)
    if (!(await updateRepo(repoId, { dictationTerms: next }, { hostId }))) {
      toast.error(
        t(
          'components.settings.voice.vocabulary.repoSaveFailed',
          "Couldn't save the repo's terms. The host running this repo may need an Orca update."
        )
      )
    }
    setPending((current) => (current === write ? null : current))
  }

  const saveTerms = (next: DictationTerm[]): void => {
    if (scope === 'repo' && repo) {
      void saveRepoTerms(repo.id, getRepoExecutionHostId(repo), next)
    } else {
      onUpdateVoiceSettings({ dictationTerms: next })
    }
  }

  return (
    <div className="space-y-3">
      <SettingsSubsectionHeader
        title={t('components.settings.voice.vocabulary.title', 'Vocabulary')}
        description={t(
          'components.settings.voice.vocabulary.description',
          'Names and code terms to spell your way. Add what the model mishears it as, if it keeps getting it wrong.'
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {scope === 'repo' && repo
            ? t(
                'components.settings.voice.vocabulary.repoScope',
                'Only used while you dictate in {{repo}}.',
                { repo: repo.displayName }
              )
            : t('components.settings.voice.vocabulary.personalScope', 'Used in every repo.')}
        </p>
        {repo ? (
          <SettingsSegmentedControl
            size="sm"
            value={scope}
            onChange={setScope}
            ariaLabel={t('components.settings.voice.vocabulary.scope', 'Terms for')}
            options={[
              {
                value: 'personal',
                label: t('components.settings.voice.vocabulary.personal', 'Personal · {{total}}', {
                  total: chipsBySpelling(personalTerms).length
                })
              },
              {
                value: 'repo',
                label: t('components.settings.voice.vocabulary.repo', '{{repo}} · {{total}}', {
                  repo: repo.displayName,
                  total: chipsBySpelling(repoTerms).length
                })
              }
            ]}
          />
        ) : null}
      </div>
      {terms.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {chipsBySpelling(terms).map((chip) => (
            <VocabularyChip
              key={chip.term}
              chip={chip}
              onRemove={() => saveTerms(terms.filter((entry) => entry.term !== chip.term))}
            />
          ))}
        </ul>
      ) : null}
      <VocabularyAddRow
        full={terms.length >= MAX_DICTATION_TERMS}
        onAdd={(entry) => {
          // A term already keys its own spelling, so a bare one needs no second entry.
          const exists = terms.some(
            (other) =>
              other.term === entry.term && (!entry.heardAs || other.heardAs === entry.heardAs)
          )
          if (!exists) {
            saveTerms([...terms, entry])
          }
        }}
      />
    </div>
  )
}

type VocabularyChipModel = { term: string; aliases: string[] }

// One chip per spelling: the stored list keeps one entry per "heard as".
function chipsBySpelling(terms: readonly DictationTerm[]): VocabularyChipModel[] {
  const chips = new Map<string, VocabularyChipModel>()
  for (const { term, heardAs } of terms) {
    const chip = chips.get(term) ?? { term, aliases: [] }
    if (heardAs) {
      chip.aliases.push(heardAs)
    }
    chips.set(term, chip)
  }
  return [...chips.values()]
}

function VocabularyChip({
  chip,
  onRemove
}: {
  chip: VocabularyChipModel
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pr-1 pl-2.5 text-xs">
      <span>{chip.term}</span>
      {chip.aliases.length > 0 ? (
        <span className="text-muted-foreground">
          {t('components.settings.voice.vocabulary.heardAsChip', '← {{heardAs}}', {
            heardAs: chip.aliases.join(', ')
          })}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs-round"
        className="size-4.5"
        aria-label={t('components.settings.voice.vocabulary.remove', 'Remove {{term}}', {
          term: chip.term
        })}
        onClick={onRemove}
      >
        <X />
      </Button>
    </li>
  )
}

function VocabularyAddRow({
  full,
  onAdd
}: {
  full: boolean
  onAdd: (entry: DictationTerm) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [term, setTerm] = useState('')
  const [heardAs, setHeardAs] = useState('')
  const canAdd = !full && term.trim() !== ''

  const add = (): void => {
    if (!canAdd) {
      return
    }
    onAdd({ term: term.trim(), ...(heardAs.trim() ? { heardAs: heardAs.trim() } : {}) })
    setTerm('')
    setHeardAs('')
  }
  const addOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Input
        className="h-8 min-w-36 flex-1"
        value={term}
        maxLength={MAX_DICTATION_TERM_LENGTH}
        placeholder={t('components.settings.voice.vocabulary.term', 'Word or phrase')}
        aria-label={t('components.settings.voice.vocabulary.term', 'Word or phrase')}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={addOnEnter}
      />
      <Input
        className="h-8 min-w-36 flex-1"
        value={heardAs}
        maxLength={MAX_DICTATION_TERM_LENGTH}
        placeholder={t('components.settings.voice.vocabulary.heardAs', 'Heard as (optional)')}
        aria-label={t('components.settings.voice.vocabulary.heardAsLabel', 'Heard as')}
        onChange={(event) => setHeardAs(event.target.value)}
        onKeyDown={addOnEnter}
      />
      <Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={add}>
        <Plus className="size-3.5" />
        {t('components.settings.voice.vocabulary.add', 'Add')}
      </Button>
    </div>
  )
}
