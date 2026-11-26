import type { Translate } from '@/i18n/use-translate'
import type { CommanderMemoryRevision } from '../../../../shared/commander/memory-contract'

export function memoryKind(t: Translate, kind: CommanderMemoryRevision['kind']): string {
  switch (kind) {
    case 'decision':
      return t('commander.memory.decision', 'Decision')
    case 'guideline':
      return t('commander.memory.guideline', 'Guideline')
    case 'note':
      return t('commander.memory.note', 'Note')
  }
}

export function memoryActor(t: Translate, type: CommanderMemoryRevision['actor']['type']): string {
  switch (type) {
    case 'human':
      return t('commander.memory.human', 'Human')
    case 'agent':
      return t('commander.memory.agent', 'Agent')
    case 'commander':
      return t('commander.memory.commander', 'Commander')
  }
}
